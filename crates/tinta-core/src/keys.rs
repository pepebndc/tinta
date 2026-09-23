use anyhow::{anyhow, Context, Result};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;

const SERVICE: &str = "app.tinta";
const ACCOUNT: &str = "library-master-key";
/// errSecItemNotFound
const ITEM_NOT_FOUND: i32 = -25300;

/// Keys derived from the master key in the Keychain.
#[derive(Clone)]
pub struct Keys {
    pub database: [u8; 32],
    pub audio: [u8; 32],
}

impl Keys {
    pub fn derive(master: &[u8]) -> Result<Self> {
        let hk = Hkdf::<Sha256>::new(Some(b"tinta"), master);
        let mut database = [0u8; 32];
        let mut audio = [0u8; 32];
        hk.expand(b"database", &mut database).map_err(|_| anyhow!("hkdf"))?;
        hk.expand(b"audio", &mut audio).map_err(|_| anyhow!("hkdf"))?;
        Ok(Self { database, audio })
    }

    pub fn audio_base64(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(self.audio)
    }

    /// Loads the master key from the Keychain, or creates it on first use.
    /// The item is a generic password that iCloud Keychain does not synchronize.
    pub fn load_or_create() -> Result<Self> {
        use security_framework::passwords::{get_generic_password, set_generic_password};
        // Debug builds can use a fixed key, so that automated tests do not wait for Keychain prompts.
        #[cfg(debug_assertions)]
        if let Ok(value) = std::env::var("TINTA_DEV_MASTER_KEY") {
            return Self::derive(&hex::decode(value).context("TINTA_DEV_MASTER_KEY must be hex")?);
        }
        let master = match get_generic_password(SERVICE, ACCOUNT) {
            Ok(value) => hex::decode(value).context("invalid master key in Keychain")?,
            // Only a missing item creates a new key. Any other error, for example a denied
            // Keychain prompt, must stop here: a new key would make the library unreadable.
            Err(error) if error.code() != ITEM_NOT_FOUND => {
                return Err(anyhow!("cannot read the library key from the Keychain: {error}"));
            }
            Err(_) => {
                let mut key = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut key);
                set_generic_password(SERVICE, ACCOUNT, hex::encode(key).as_bytes())
                    .context("cannot store the master key in the Keychain")?;
                key.to_vec()
            }
        };
        Self::derive(&master)
    }

    /// Test keys that never touch the Keychain.
    pub fn for_tests() -> Self {
        Self::derive(&[7u8; 32]).expect("derive")
    }
}

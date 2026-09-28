use anyhow::{anyhow, Context, Result};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;

const SERVICE: &str = "com.usetinta.tinta";
/// The service of the master key in versions before 0.4.0.
const OLD_SERVICE: &str = "app.tinta";
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
        use security_framework::passwords::set_generic_password;
        // Debug builds can use a fixed key, so that automated tests do not wait for Keychain prompts.
        #[cfg(debug_assertions)]
        if let Ok(value) = std::env::var("TINTA_DEV_MASTER_KEY") {
            return Self::derive(&hex::decode(value).context("TINTA_DEV_MASTER_KEY must be hex")?);
        }
        let master = match read_item(SERVICE)? {
            Some(value) => value,
            None => match read_item(OLD_SERVICE)? {
                // Moves the key of an older version to the current service, once. The app creates
                // the new item, so macOS does not ask for access to it again.
                Some(value) => {
                    set_generic_password(SERVICE, ACCOUNT, &value)
                        .context("cannot store the master key in the Keychain")?;
                    let _ = security_framework::passwords::delete_generic_password(OLD_SERVICE, ACCOUNT);
                    value
                }
                None => {
                    let mut key = [0u8; 32];
                    rand::thread_rng().fill_bytes(&mut key);
                    let value = hex::encode(key).into_bytes();
                    set_generic_password(SERVICE, ACCOUNT, &value)
                        .context("cannot store the master key in the Keychain")?;
                    value
                }
            },
        };
        Self::derive(&hex::decode(master).context("invalid master key in Keychain")?)
    }

    /// Test keys that never touch the Keychain.
    pub fn for_tests() -> Self {
        Self::derive(&[7u8; 32]).expect("derive")
    }
}

/// Reads the master key item of a service. Only a missing item gives `None`. Any other error,
/// for example a denied Keychain prompt, must stop the app: a new key would make the library unreadable.
fn read_item(service: &str) -> Result<Option<Vec<u8>>> {
    match security_framework::passwords::get_generic_password(service, ACCOUNT) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
        Err(error) => Err(anyhow!("cannot read the library key from the Keychain: {error}")),
    }
}

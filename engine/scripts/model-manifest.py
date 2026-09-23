import json, urllib.request, hashlib, os, sys
root = os.path.expanduser("~/Library/Application Support/FluidAudio/Models")
repos = {
 "parakeet-tdt-0.6b-v3": ("FluidInference/parakeet-tdt-0.6b-v3-coreml", "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe"),
 "silero-vad": ("FluidInference/silero-vad-coreml", "b419383c55c110e2c9271fa6ee0ea83d03c70d96"),
 "speaker-diarization": ("FluidInference/speaker-diarization-coreml", "df2625ac79a7ac6b65ad868fee6d80f320da4232"),
}
manifest = {}; problems = 0
for folder, (repo, rev) in repos.items():
    url = f"https://huggingface.co/api/models/{repo}/tree/{rev}?recursive=true"
    remote = {}
    import subprocess
    for f in json.loads(subprocess.check_output(["curl","-s",url])):
        if f["type"] != "file": continue
        remote[f["path"]] = ("sha256", f["lfs"]["oid"]) if f.get("lfs") else ("gitsha1", f["oid"])
    base = os.path.join(root, folder)
    for dirpath, _, files in os.walk(base):
        for name in files:
            full = os.path.join(dirpath, name); rel = os.path.relpath(full, base)
            data = open(full, "rb").read()
            if rel not in remote:
                print("LOCAL ONLY", folder, rel); continue
            kind, oid = remote[rel]
            got = hashlib.sha256(data).hexdigest() if kind == "sha256" else hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
            if got != oid: print("MISMATCH", folder, rel); problems += 1
            manifest[f"{folder}/{rel}"] = hashlib.sha256(data).hexdigest()
print("files", len(manifest), "problems", problems)
json.dump(manifest, open("model-manifest.json","w"), indent=1, sort_keys=True)

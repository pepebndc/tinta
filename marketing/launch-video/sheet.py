import subprocess, sys, glob
pre = sys.argv[1] if len(sys.argv) > 1 else "t"
files = sorted(glob.glob(f"stills/{pre}*.jpg"), key=lambda f: float(f.split("/")[-1][1:-4]))
W, H = (480, 270) if pre == "t" else (270, 480)
cols = 4 if pre == "t" else 8
for n, chunk in enumerate([files[i:i + 20] for i in range(0, len(files), 20)]):
    args = sum([["-i", f] for f in chunk], [])
    fc = "".join(f"[{i}]scale={W}:{H}[v{i}];" for i in range(len(chunk))) + "".join(f"[v{i}]" for i in range(len(chunk)))
    fc += f"xstack=inputs={len(chunk)}:layout=" + "|".join(f"{(i % cols) * W}_{(i // cols) * H}" for i in range(len(chunk))) + ":fill=black"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args, "-filter_complex", fc, "-frames:v", "1", f"c{n + 1}.jpg"], check=True)
    print(f"c{n + 1}.jpg:", " ".join(f.split("/")[-1][1:-4] for f in chunk))

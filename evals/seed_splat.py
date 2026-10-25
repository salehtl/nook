# Calibration baseline for evals/psnr_judge.mjs: turn a capture's seed points into a naive, untrained splat.
import sys, numpy as np
src, dst = sys.argv[1], sys.argv[2]
raw = open(src, 'rb').read(); end = raw.index(b"end_header\n") + 11
n = int([l for l in raw[:end].decode().splitlines() if l.startswith("element vertex")][0].split()[2])
d = np.frombuffer(raw, dtype=[('x','<f4'),('y','<f4'),('z','<f4'),('r','u1'),('g','u1'),('b','u1')], count=n, offset=end)
f = ["x","y","z","nx","ny","nz","f_dc_0","f_dc_1","f_dc_2","opacity","scale_0","scale_1","scale_2","rot_0","rot_1","rot_2","rot_3"]
o = np.zeros((n, len(f)), '<f4'); o[:,0]=d['x']; o[:,1]=d['y']; o[:,2]=d['z']
for k,c in enumerate('rgb'): o[:,6+k] = (d[c]/255.0 - 0.5)/0.28209479
o[:,9]=4.0; o[:,10:13]=np.log(0.012); o[:,13]=1
open(dst,'wb').write(("ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % n + "".join(f"property float {x}\n" for x in f) + "end_header\n").encode() + o.tobytes())
print(n, "seed splats")

# Auto DJ third-party components

**Beat This!** (Foscarin, Schlüter and Widmer, ISMIR 2024), code and weights
under BEAT_THIS-LICENSE (MIT), https://github.com/CPJKU/beat_this at
`b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c`. Soundsible redistributes the
`final0` checkpoint exported to ONNX (`beat_this-final0.onnx`, a release asset
whose SHA-256 is in `shared/dj/weights.py`; export in
`docs/dj/detector_comparison/onnx_probe.py`). `shared/dj/beat_model.py` ports
its log-mel frontend, chunked prediction and DBN input in NumPy. The export
computes the same attention one band or head at a time; the P12-a comparison
found identical events on all 62 inputs.

**madmom** source code under MADMOM-LICENSE (BSD 2-clause),
https://github.com/CPJKU/madmom at `27f032e8947204902c675e5e341a3faf5dc86dae`.
`shared/dj/dbn.py` ports `DBNDownBeatTrackingProcessor` and its bar state
space, transition and observation models and Viterbi decoding to NumPy. No
madmom model or data file is used or redistributed: those are licensed
separately (CC BY-NC-SA) and Soundsible does not include them.

# HALOFLUX artifacts

This directory contains the binary/video/trace artifacts referenced by the P4.1–P4.3 reports. Reports and raw test evidence remain under `reports/p4/` and `tests/evidence/p4/`.

## Video

| File | Content | Frames / FPS | SHA256 |
|---|---|---|---|
| `video/live-replay-35s-r3.webm` | P4.1-R3: LIVE → TRACE → REPLAY → LIVE | 854 / 24.4 | `9f3468b24e614e195718a45de642565d6bbddd7e30d995bc269ee161b06388aa` |
| `video/live-replay-35s-r2.webm` | R2 build: same flow, 15.7 fps gate-fail evidence | 551 / 15.74 | `d6fdcd1c59acaa4dc3878120b40ef4c341d5274cc1382ab707cf6bb02d86dd3d` |
| `video/live-replay-35s-p4.webm` | P4.1 build: same flow, 24.86 fps | 870 / 24.86 | `41ab45d6134069acc75388ddd9a8826ecce26c5e8e3fdf0616b1082e29c78246` |
| `video/replay-full-p3.mp4` | P3 historical REPLAY clip | 5 s / 4 fps | `9b940b3fa29923ec095dbaef9ebadb55b85b43e17138a973cad6b5f0a4b45d5e` |
| `video/p42-final-35s.webm` | P4.2 final | 858 / 24.5 | `992e4fa78e4fd37ce11389aeb3cf593a23b54a329309982903d7101d02ce955b` |
| `video/p43-final-35s.webm` | P4.3 final | 842 / 24.1 | `d93d0f1a9d1948e338453d943380eef03852ca9db2db6eb1cd1425ebdfc267df` |

Videos are window-only captures (desktopCapturer window source), not full-desktop recordings.

## Chrome Trace

| File | Use |
|---|---|
| `traces/trace-2500-play-lite.json.gz` | authoritative 10 s, 2500 replay trace (167,774 events) |
| `traces/trace-2500-play-lite-analysis.json` | per-thread aggregation used by the P4.1-R3 root-cause report |

Additional raw traces remain at:

- `tests/evidence/p4/trace-2500-play.json.gz`
- `tests/evidence/p4/trace-2500-play-r3.json.gz`
- `tests/evidence/p4/trace-replay-2500-paused.json.gz`
- `tests/evidence/p4/trace-visual-only.json.gz`

## Reports

- `reports/p4/P4.1-R3-ROOT-CAUSE.md`
- `reports/p4/P4.1-R3-OPTIMIZATION.md`
- `reports/p4/P4.1-R3-GATE.md`
- `reports/p4/P4.1-R4-RESPONSIVE.md`
- `reports/p4/P4.1-FINAL-ACCEPTANCE.md`
- `reports/p4/P4.2-FINAL.md`
- `reports/p4/P4.2-A-TIME-ARC.md`
- `reports/p4/P4.2-B-TOOL-WATERFALL.md`
- `reports/p4/P4.2-C-EVIDENCE-NETWORK.md`
- `reports/p4/P4.2-D-EVENT-BEAMS.md`
- `reports/p4/P4.3-INSTRUMENTS-TOKENS.md`

`manifest.json` records byte size and SHA256 for every file in this directory.

## Integrity

Source baseline when these artifacts were generated: `3240430`. Main is not merged; PR #1 remains Draft.

200% zoom and P4.2/P4.3 screenshots are under `screenshots/p4/`.

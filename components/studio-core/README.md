# Studio core

The rules every Dashcam Studio editor shares (the car app, the phone and web app, the PC Studio), so they cannot
disagree about what an edit means.

| File | What it holds |
|---|---|
| `recipe.js` | The edit itself, version 1 (`<name>.edit.json`): read, check, write, safe file names, conflicts |
| `clipname.js` | One name per clip (`YYYY-MM-DD HH.MM.SS`) from any place's file or folder name |
| `timeline.js` | Drive seconds to per-clip parts and back; length; what is showing at a time in the edit |
| `speedtrack.js` | The speed, and only the speed, out of the car's data file |
| `geometry.js` | Where each camera sits in the 2 x 2 picture and how it lands in each output shape |
| `library.js` | A list of file names sorted into clips, saved edits and drives, for editors with no library program |
| `tsmp4.js` | The car's .ts clip rewrapped as an .mp4 a browser plays, in memory, without re-encoding (`tools/test_studio_ts.js`) |
| `fixtures/` | Test cases shared with the PC Studio's Python port (`C:\dev\dashcam-studio\recipe.py`) |

## Rules for this folder

- Loads on Node 8.16.2 and in a browser: no built-in modules (`fs`, `path`), no syntax newer than Node 8.
- Nothing throws on bad input. Functions hand back a result with `errors`.
- A recipe never holds a VIN, a position, a file path or a person's name. `check()` copies known keys only.
- The car's data file beside each clip holds a VIN and positions. Only `speedtrack.js` reads it, and only speed.
- No real VIN or position in a fixture, a test or a log line. Fixtures use made-up values.
- A change to a rule here is a change to `recipe.py` and to the fixtures in the same commit.

## Tests

    npx -y node@8.16.2 tools/test_studio_core.js

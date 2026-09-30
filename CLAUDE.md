# Notes for Claude

## Version number — update it with every change that gets merged

The version shown at the bottom of the settings panel is the sum of the
`?v=` tags on the three app files in `index.html`:

```html
<link rel="stylesheet" href="style.css?v=…">
<script src="script.js?v=…"></script>
<script src="features.js?v=…"></script>
```

Every time a change is merged (or pushed to `main`), bump the `?v=` tag of
each file that changed by 1, in the same commit as the change. This both
busts the browser cache and makes the version number go up, so the user can
tell whether a device has the latest update. Never merge a change to
`style.css`, `script.js` or `features.js` without bumping its tag.

## Always push to `main`

When a change is done, commit it and push it straight to `main` (after
bumping the version tags above) — that's what deploys the app (Vercel).
Don't leave work only on a side branch or ask first.

## "The list 3 slide" — the app's standard motion

When the user says **"the list 3 slide"** (or "the app's animation", "same
timing as everything else"), they mean the motion list 3's rows use:
**520ms, `cubic-bezier(0.4, 0, 0.2, 1)`** — `ROW_MOTION_MS` and `rowEase`
in `script.js` (in CSS: `0.52s cubic-bezier(0.4, 0, 0.2, 1)`). Use it for
anything entering, leaving, resizing or sliding unless told otherwise.

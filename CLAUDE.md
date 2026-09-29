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

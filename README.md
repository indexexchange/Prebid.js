## Replace IX Files in Your Local Prebid.js Build

Follow these steps if you maintain your own local Prebid.js build and want to test the latest Index Exchange adapter changes with ORTB Converter support.

These files are for **Prebid.js 9.11.0 – 9.53.5**. Do not copy them into a different Prebid.js version. For Prebid.js 10.x, use the `OrtbConverterSupport-10.29.1` branch instead.

### 1. Download the Updated Files
Obtain the following updated files from Index Exchange:

```
/modules/ixBidAdapter.js
/libraries/ixUtils/ixUtils.js
```

### 2. Copy the Files Into Your Build
Copy both files into your local Prebid.js source directory. `ixBidAdapter.js` replaces the existing file; `ixUtils.js` is new, so create the `libraries/ixUtils/` folder if it does not exist.

Example:
```
your-prebid-repo/
├── modules/
│   ├── ixBidAdapter.js    ← Replace this file
│   └── ...
└── libraries/
    ├── ixUtils/           ← New folder
    │   └── ixUtils.js     ← Add this file
    └── ...
```

### 3. Rebuild Prebid.js
Run the Prebid build command with the same module list you use today, so the bundle keeps your other bidders and modules:
```bash
gulp build --modules=ixBidAdapter,<your other modules>
# or
gulp build --modules=path/to/your/modules.json
```

This will create a new `prebid.js` bundle in your `/build/dist` directory.

### 4. Deploy the Updated Build
Use the newly built Prebid.js file on your test page in place of your existing bundle.

```html
<script src="path/to/your/build/dist/prebid.js"></script>
<script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
```


### Verification
To verify the correct integration, inspect outgoing bid requests in your browser’s network tab (filter for `openrtb/pbjs`).
Check the `ext.ixdiag.version` field in the request payload:

| Mode                    | Example `ext.ixdiag.version` |
| ----------------------- | ---------------------------- |
| Cold Start / Unassigned | `9.41.0-ortb-default-2`      |
| Legacy                  | `9.41.0-ortb-disabled-2`     |
| ORTB Converter          | `9.41.0-ortb-enabled-2`      |

If the version string includes `-ortb-`, the updated adapter is installed. The ORTB Converter is active when it ends in `-ortb-enabled-2`.

**Note: Please contact Index Exchange to enable the new ORTB Converter flow.**

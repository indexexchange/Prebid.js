## 🧩 Replace IX Files in Your Local Prebid.js Build

Follow these steps if you maintain your own local Prebid.js build and want to test the latest Index Exchange adapter changes with ORTB Converter support.

### 1. Download the Updated Files
Obtain the following updated files from Index Exchange:

```
/modules/ixBidAdapter.js  
/libraries/ixUtils/ixUtils.js
```

### 2. Replace Existing Files
Copy both files into your local Prebid.js source directory, replacing the existing versions.

Example:
```
your-prebid-repo/
├── modules/
│   ├── ixBidAdapter.js    ← Replace this file
│   └── ...
└── libraries/
    ├── ixUtils/
    │   ├── ixUtils.js     ← Replace this file
    └── ...
```

### 3. Rebuild Prebid.js
Run the Prebid build command to generate a new bundle with the updated IX adapter:
```bash
gulp build --modules=ixBidAdapter
```

This will create a new `prebid.js` bundle in your `/build` directory.

### 4. Deploy the Updated Build
Use the newly built Prebid.js file on your test page in place of your existing bundle.

```html
<script src="path/to/your/build/prebid.js"></script>
<script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
```


### ✅ Verification
To verify the correct integration, inspect outgoing bid requests in your browser’s network tab.
Check the `ext.ixdiag.version` field in the request payload:

| Mode                    | Example `prebidjs_version` |
| ----------------------- | -------------------------- |
| Cold Start / Unassigned | `10.18.0-ortb-default`     |
| Legacy                  | `10.18.0-ortb-disabled`    |
| ORTB Converter          | `10.18.0-ortb-enabled`     |

When the ORTB Converter is active, the version string will include -ortb.

**Note: Please contact Index Exchange to enable the new ORTB Converter flow.**

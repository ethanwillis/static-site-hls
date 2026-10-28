# static-site-hls developer documentation

For people changing static-site-hls. Users want the [README](../README.md).

Read in this order:

| Document | Answers |
| --- | --- |
| [architecture.md](architecture.md) | What are the parts and how do they fit? C4 diagrams: system context, containers, components, deployment; module map; design decisions |
| [scroll-integration.md](scroll-integration.md) | What exactly does the tool read and change in a Scroll site, and how does `scroll build` fit in? |
| [workflows.md](workflows.md) | What happens, in what order, during `convert`, re-runs, index migration, settings changes, page load and `serve`? |
| [data-model.md](data-model.md) | Which types and files pass between the parts? The index and player config schemas, in-process types, the data folder, index versions and migrations |
| [development.md](development.md) | Setup, tests, trying changes, updating dependencies, staged releases |

In one paragraph: the CLI asks the **planner** (`scan()`) for a `ScanPlan`. The planner reads the site's **index** (migrating old versions), finds every video reference in the `.scroll` files and hashes the videos. After confirmation the **executor** (`apply()`) converts what changed with **WASIX ffmpeg** (stream copy into HLS, plus a poster), installs the **player**, rewrites the `.scroll` references to the playlists, saves the index and runs **`scroll build`**. In the visitor's browser the inlined player sets posters and, where HLS isn't native, attaches hls.js.

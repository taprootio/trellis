# Viewer API fixtures

One file per route (`backlogs.json`, `backlog.json`, `task.json`, `search.json`). Each holds `variants`, a map of variant name to `{ description, optional, nullable, freeForm, response }`, where `response` is an example body.

A response matches its variant when every key in the example is present with the example's JSON type (arrays compare each element with the example's first element) and no key outside the example appears. Paths in `optional`, `nullable` and `freeForm` are dotted, with `[]` for array elements (`tasks[].completed_on`): an `optional` key may be absent, a `nullable` value may also be `null`, and `freeForm` objects (the raw front matter) have unchecked children. The built-viewer layout is in the TRL0005 plan, not here.

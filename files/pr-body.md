The landing linearizer rejects the inventory stamp resolved inside merge commit 3de4500376e9a7183e4c5443cd11805536edb202. This candidate replays that gated CLI content as one ordinary commit on main34847bae, keeping main's advisory cliVersion0.2.118.

The full diff against the gated tree is only default-seed/scripts/base-cli/inventory.json, and its only changed field is cliVersion. All application, CLI, exported runtime, test and documentation bytes remain unchanged.

| Tree | SHA |
| --- | --- |
| Gated3de45003 | e1b707e2994d6b38425315f0c4468060aebb9d50 |
| Linear candidate | 1af01ea30cef6c96888764162976a8cb7d0d3805 |

Validation: installed linearize check PASS; five agent/run command checks plus the maintained portable-inventory check and reference typecheck PASS. Own supported COMPLETE full-history publication scan PASS, zero new findings/166 pre-existing, against canonical runeditrun/base#main34847bae.

This draft starts the repository's native pull_request Verify for the frozen candidate. The new-head independent tree-identity gate and guarded landing remain pending with their respective owners.

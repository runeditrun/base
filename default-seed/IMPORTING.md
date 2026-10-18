# Move your people in

On the source installation, sign in as its owner and open:

```text
/app/import
```

Choose **Export people** to download `people.json`. Launch a fresh copy of this
seed with `rer dev`, open its private `RER_OPEN` link to claim the local owner,
and confirm setup. Open `/app/import` on that destination and choose the file.
The browser sends the original bytes to the shared import door.

Choose **Upload and review**. Planning leaves native people unchanged. Review
the source and effect counts, differences and rejected records. Check **I
reviewed these changes and approve this import**, then choose **Apply reviewed
import**. The screen applies bounded batches until the job finishes; a refresh
can recover its saved status. Choose **Reconcile native records** to compare
the applied plan against the native records, or **View people** to read them.
The history records who approved each import. **Undo import** removes unchanged
imported people; the engine protects records changed after the import.

To update a completed import from the same source, export it again and select
**Update an earlier import from the same source** before reviewing a new plan.
A failed apply is terminal for that approval: the screen names the failure,
keeps status and Undo available, and asks for a new upload, plan and review.
An erasure may withdraw the retained snapshot; the door refuses further use of
that snapshot rather than restoring the erased content. For a first pending
import, roll it back with Undo, then review a clean export containing only the
remaining people. If an earlier completed lineage also lost its snapshots, new
plans for that source remain blocked by the shared door. Preserve the unrelated
native people; do not undo a completed lineage merely to clear that refusal.
This recovery limit is tracked upstream.

This export contains only references, names, emails and JSON details:

```json
[{"ref":"alice","name":"Alice Chen","email":"alice@example.test","details":{"team":"Support"}}]
```

Notes, files, audit events, owner access and installation configuration are
outside this people transfer. They are not silently reconstructed. Unknown
fields or invalid records are rejected. Imports never send mail or invitations.
The screen also accepts the legacy people source envelope `{ "people": [...] }`.
Do not upload the per-person privacy export or a `.rer` installation archive.

Business uses this same door with signed, action-bound grants. It starts off;
the owner can enable it and permanently revoke signing keys under **Business
imports**. Disabling Business leaves the owner's history and Undo available.

Low-level `rer export`/`rer import` back up and restore this installation. They
remain a separate developer-only recovery mechanism, described
in [RUN-LOCALLY.md](RUN-LOCALLY.md); they have no reviewed door plan or Undo.

# Schema changes

Applied against the live project. Recorded here so the schema a deployed
function depends on is reviewable, and so a rebuild does not have to be
reconstructed from the running database.

Files are named `<date>_<what>.sql` and are idempotent where that is cheap.

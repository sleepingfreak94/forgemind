# Preserved ForgeMind proposal for corrective implementation

These text files are byte-exact reference inputs from the actual Native coding invocation in schema3-core-full-v2. They are not executed source or an accepted implementation. The task failed its candidate check: 26 of 27 tests passed; the remaining test accessed nonexistent f.memory.database.db. No independent Native review ran.

Worker source: `f8d4ef7dd442bb92c8407c93346377d9ae729e479bd69b1c8c855e20ce4bb245`. Original source: `9b68bd40232520a16af5029a6068fce36788b81e5a5fca8dbd6f3d2c175503a2`. Terminal receipt SHA256: `df3a4ea9f6430b5a2d6e6f7e309d016ba0d0306d22b28c8c2aeed479a3de6f3b`.

- docs/plans/schema3-core-reference-database.txt: `b1080d882d1c12ba23afe784c40fdf3c1d9d28458dda5192957e65dc412434ff`
- docs/plans/schema3-core-reference-tests.txt: `b1e610952dbae5c1db1baa0d7499c1a813fbb96fd69f380ea5cdaf582ce244ac`

The next fresh full harness task must generate the actual source/test edits, correct the fixture through owner-controlled MemoryDatabase construction and unconditional close, preserve assertions, satisfy the original schema requirements, and pass every check plus fresh independent review. The trigger must also invalidate on new revoked/null-body state or body/digest changes. Exhaustive actual revocation proof remains required before weekly store work. Original failed artifacts and worktree remain preserved.

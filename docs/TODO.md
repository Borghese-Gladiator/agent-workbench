# TODO

## UI

- [ ] **Failed-claim actions on the task page.** The task page shows the failed claim ids in a callout, and each claim row shows its reasons. Retry is in the page header. The Rewrite form is in the Verification tab. Put a "Rewrite this test" button in each failed claim row. The button calls the same route as `awb prove --rewrite C1`. Show the last reason and the video link in the row. A failed task shows one "Retry task" button next to the callout. Claims for the proof:
  - A failed claim row has a "Rewrite this test" button. A passed claim row has none.
  - A click on the button starts the rewrite for that claim only.
  - The callout links to the first failed claim row.
- [ ] **Failed claims across tasks.** Do this only if the task page change is not enough. The Live page lists tasks that need attention. Add one list of every failed claim with its task, its reason and a link to the claim row. The list has a filter by repository.

AGENT WORKBENCH V4

## TO DO - features to update
- incorporate memory per project
  - Redis Iris?
  - custom markdown files?
  - gigantic doc with all tech decisions AND skill to wraup
- [ ] try out Agent Memory
  - https://www.agent-memory.dev
  - https://chatgpt.com/c/6a0c733e-547c-8326-a1d2-f6de9f2559cd


- [ ] GitHub Speckit investigation
- [ ] BUG - auto update UI as status changes (WebSocket)
- [ ] FEATURE - OpenCode implementation
- [ ] Feature - OpenCode to fix en masse with minimal changes
  ```
  I dont really know who else this helps but in my quest to use local only models all the time, in a recent PR I had to modify hundreds of tests, this would have been fairly lossy for a large leading model to do, instead I was able to do
   cat failing_tests.txt | xargs -P 5 -I {} bash -c "opencode run --model \"llvm/qwen/qwen3.6-35b-a3b\" --agent \"python-pro\" \"<VERBOSE_WAY_OF_SAYING_FIX_MY_TESTS> in {}\""
  open code worked overnight and I came back in the morning to hundreds of fixed tests with minimal changes needed in the morning

  The paradigm of having the agents work on indiviual files in a loop was far better than dumping the whole laundry list of failures to claude
  ```
  - setup OpenCode




## TO DO - projects to build
- (work) build greenfield project
- (work) edit existing project
  - app
  - fender
- (work) Sentry triage
- (personal) adhoc scripts
  - PROBLEM: I have to manually click through Workday software and download an Excel for each payslip individually
  - PROBLEM: I have to merge all of these Excel payslips when I want their per month aggregate data
- (personal) implement browser games
  - Othello
- (personal) implement PWA
  

  - build tech debt bub tickets
    - Catalog data source 
    - tickets from Sentry bugs
- Algorithm Trading project
  - [ ] make Mahjong (chinese OR japanese toggle)
  - QA - not thorough enough resulting in run success, but bad artifact that was not tested well (Sheng Ji game does not work, multiple websocket opening from clicking same button "Join")


```
Run a demo that implements this ticket inside a worktree for Klaviyo App
Implement: https://linear.app/klaviyo/issue/CORE-242/return-an-error-state-for-invalid-requests-on-catalogdatasource

Run a demo that implements this ticket inside a worktree for Klaviyo Fender
https://linear.app/klaviyo/issue/CORE-729/fix-typeerror-in-klaviyobarchart-when-graphdata-is-null-fender
```

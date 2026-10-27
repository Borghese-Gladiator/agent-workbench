# PR Summary: fender_58633

- **Title**: [CORE-587] Funnel Channel Summary - frontend pre-migration logic
- **Author**: timothysheee
- **State**: OPEN
- **URL**: https://github.com/klaviyo/fender/pull/58633
- **Created**: 2026-05-04T16:24:35Z
- **Closed**: n/a
- **Merged**: n/a
- **Files changed**: 2  (+51 / -31)
- **Review decision**: REVIEW_REQUIRED
- **Labels**: 

## PR Description

[CORE-587 - [SCF] Migrate to multi-channel funnel summary widget](https://linear.app/klaviyo/issue/CORE-587)

## Short Description
Backend pre-migration logic for Funnel Summary Chart widget. In the future, we will replace all Email,SMS,Push funnel summary widgets with a single multi-channeled widget. This PR uses a feature flag to control what charts are visible, so we can proceed with the migration

The companion backend pre-migration is here: https://github.com/klaviyo/app/pull/116708.

#### Changes
- `client/app/performance-dashboard/src/Components/Modals/DataViewLibraryModal.tsx`
  - only show legacy rows if gate is OFF
- `client/app/performance-dashboard/src/Components/Modals/DataViewLibraryModal.test.tsx`
    - gate OFF: Email/SMS/Push Funnel Summary present, "Funnel Summary by Channel" absent
    - gate ON: "Funnel Summary by Channel" present, Email/SMS/Push absent

## Instructions for Review/Testing
[Testing Plan GDoc](https://docs.google.com/document/d/1OtP7GorEQPq4utGIOTd66shvlq66OWA72cmLuWllw8s/edit?tab=t.ghx09rxseaho#heading=h.ypssrpvigah4)

- validate adding widgets with gate on/off locally
- validate adding widgets with gate on/off in webserver


#### Results
<!-- Picture / Gif / Video of changes -->

<details>
<summary><h2>Checklist for PR Authors</h2></summary>

- [X] I have performed a self-review of my code.
- [X] In hard-to-understand areas, I have added comments for maintainability.
- [X] I have made best efforts to split my PR into reasonably sized chunks for review.
- [X] I have made corresponding changes to the documentation (e.g. READMEs, tsdocstrings).
- [X] My changes generate no new warnings.
- [X] I have added unit tests that prove my fix is effective or that my feature works.
- [X] I have added a relevant integration/e2e test for the changes presented. => None needed!
- [X] I have tested my changes on multiple browsers with assetSource. Note: testing across Chrome, Firefox, and Safari is usually sufficient.
- [X] I am contributing to the Component Library and I have read the [component library contributions guidelines](https://fender.documentation.klaviyo.com/docs/getting-started/contributing-guide/). => Not changed!
- [X] I am adding a New Package. I have read the [package contributions guidelines](https://fender.documentation.klaviyo.com/docs/guides/add-package/). => Not changed!
- [X] I adhered to [I18N Best Practices](https://fender.documentation.klaviyo.com/docs/internationalization/best-practices/) ℹ️ **NOTE: If you added any new strings to translations files, after merging your PR, turn on Context Capture with the i18n chrome extension and verify the deployment in production without assetSource on a test account. [See how here](https://klaviyo.atlassian.net/wiki/spaces/EN/blog/2024/01/26/4035051684/Context+Gathering+for+French+app).**
</details>


---

## Reviews (top-level review submissions)

### Review by @gillian-palmer — COMMENTED — 2026-05-07T13:49:14Z

I just tested on my local and I was able to add more widgets when the feature flag was on even when there would be 10 widgets if the feature flag was off. The desired behavior is that if there are 10 widgets either with the feature flag on or with it off, then the button should be disabled. You'll probably also want a new translation for if there's the temp max limit of 8 or 9 widgets (if there's 2 or 3 funnel widgets hidden)
Also double check that the celery task is only processing the widgets that are visible. I just checked in Tilt and saw the by channel funnel widget even when the feature flag was off.

---

## Inline Review Comments (on diff)

### @gillian-palmer on `client/app/performance-dashboard/src/Components/Modals/DataViewLibraryModal.tsx:85` — 2026-05-07T13:40:16Z

```diff
@@ -80,24 +80,11 @@ const DataViewWidgetOptions = (
     type: WidgetType.PERFORMANCE_DETAIL,
     subtype: WidgetSubtype.FORM,
   },
-  {
-    title: t('dataViewLibrary.title.emailFunnelSummary'),
-    description: t('dataViewLibrary.description.emailFunnel'),
-    type: WidgetType.FUNNEL_SUMMARY,
-    subtype: WidgetSubtype.EMAIL,
-  },
-  {
-    title: t('dataViewLibrary.title.smsFunnelSummary'),
-    description: t('dataViewLibrary.description.smsFunnel'),
-    type: WidgetType.FUNNEL_SUMMARY,
-    subtype: WidgetSubtype.SMS,
-  },
-  {
-    title: t('dataViewLibrary.title.pushFunnelSummary'),
-    description: t('dataViewLibrary.description.pushFunnel'),
-    type: WidgetType.FUNNEL_SUMMARY,
-    subtype: WidgetSubtype.PUSH,
-  },
+  // CORE-587: When the multi-channel funnel summary gate is ON, only the
+  // unified BY_CHANNEL row is offered. When OFF, the legacy per-channel rows
+  // (Email/SMS/Push) are offered instead. Once the SCD fender PR (#58560)
```

I don't think this comment is necessary

---

## Issue-Level Comments (PR conversation)

### @linear-code[bot] — 2026-05-04T16:24:40Z

<!-- linear-linkback -->
<details>
<summary><a href="https://linear.app/klaviyo/issue/CORE-587/scf-migrate-to-multi-channel-funnel-summary-widget">CORE-587 [SCF] Migrate to multi-channel funnel summary widget</a></summary>
<p>

### User story

As a Klaviyo customer, I want my Performance Dashboard to show a single unified funnel summary widget covering all send channels instead of separate per-channel widgets, so that I can see all my funnel data in one place.

### Background

Today, dashboards contain separate Email, SMS, and Push funnel summary widgets. This ticket replaces them with a single BY_CHANNEL widget using the same phased approach as the SCD migration — code ships first, a database migration runs post-deploy, and then the feature flag is gradually ramped to expose the new widget to users. The old per-channel rows are not deleted here; they coexist invisibly in the background until a follow-on cleanup ticket.

This ticket follows the same strategy as the SCD migration ([CORE-586](https://linear.app/klaviyo/issue/CORE-586/scd-migrate-to-multi-channel-deliverability-widget)). SCF-specific flag names and subtype values should be confirmed before implementation begins.

### What needs to happen

**Before the migration runs**, the backend needs to understand the SCF feature flag and serve the right widget based on it — the new BY_CHANNEL widget when the flag is on, and the old per-channel widgets when it's off. Supporting changes include: the widget limit check accounting for the temporary coexistence of multiple rows per dashboard, new dashboards getting the correct widget type, and newly created BY_CHANNEL widgets processing automatically on first visit rather than waiting for the next scheduled refresh.

Note: if the loading state staleness fix was already introduced as part of the SCD migration, confirm it also covers funnel summary widgets — it may need only a minor extension rather than a full re-implementation.

**After the code is deployed**, a database migration inserts a BY_CHANNEL funnel widget for every dashboard that currently has a per-channel funnel widget. Runs in batches and is safe to re-run.

**Once the migration is complete**, the feature flag is ramped gradually with monitoring between steps.

### Rollback

Disable the flag at any point. The old per-channel rows remain in the database throughout this ticket.

### What to watch during ramp

* First-load spinners on the new widget are expected on first visit per company — resolves automatically
* Any dashboard showing zero funnel summary widgets (filtering bug)
* Errors rendering the new widget after the spinner resolves
* Celery queue depth for the new funnel summary processor

---

### Open questions & considerations

**Widget ordering**

We need the BY_CHANNEL widget to appear in the same position the user's existing funnel widgets occupied — not appended to the end. The migration sets BY_CHANNEL's position to match the first per-channel funnel widget at the time the migration runs (using the minimum position across Email, SMS, Push). However, there is a window between when the migration runs and when the flag is enabled during which a user could reorder their funnel widgets — BY_CHANNEL won't follow since it's hidden. Questions to resolve:

* Do we need a pre-ramp order sync immediately before enabling the flag, to re-align BY_CHANNEL's position?
* After the legacy rows are deleted (in the follow-on ticket), the order sequence will have gaps where the old per-channel rows used to be. Are orders renormalized on dashboard load? Does a gap cause rendering or reorder issues?
* Context: same as SCD — the existing `delete_widget` behavior doesn't update sibling positions, gaps are endemic in production (max observed position is 29 with a 10-widget limit), and the frontend handles gaps gracefully. But worth confirming nothing specific to SCF changes this picture, especially since SCF can remove up to 3 rows (Email + SMS + Push), leaving a larger gap than SCD.

**Migration scale and operational safety**

The widget table has approximately 37M rows; the performance dashboard table has approximately 6M rows. Things to confirm:

* Test against a database snapshot before running in production — confirm runtime estimate on a clone.
* The INSERT migration must use keyset pagination to avoid expensive full-table scans on each batch iteration. Confirm the correct index is available.
* PTOSC does not apply here — per the [eng-handbook](<https://github.com/klaviyo/eng-handbook/blob/master/databases/migrations/ptosc.md>), PTOSC is for DDL schema changes, not DML data migrations like this. The same operational discipline still applies: batched execution outside a transaction, DB snapshot first, monitor DML latency.
* Confirm with the platform team whether the migration runs inline at deploy or as a post-deploy background step.
* SCF may affect more rows per dashboard than SCD (up to 3 per-channel rows vs. 2) — factor this into the runtime estimate.

### Dependencies

See linked work items
</p>
</details>
<!-- linear-review-link -->
<p><a href="https://linear.app/klaviyo/review/featapex-core-587-fender-picker-filter-for-multi-channel-funnel-ee83f05ff84e">Review in Linear</a></p>


### @klaviyo-code-delivery[bot] — 2026-05-04T16:30:53Z

## Test Coverage and Code Quality

No coverage change was detected for this PR

[Eng handbook docs](https://github.com/klaviyo/eng-handbook/blob/master/testing/coverage-diff-reports.md)

### @gillian-palmer — 2026-05-07T13:49:45Z

Could you also link your migration script (if it's ready) so that I can test running that on my local as well?

### @timothysheee — 2026-05-07T14:07:16Z

> Could you also link your migration script (if it's ready) so that I can test running that on my local as well?

Sure, it's here: https://github.com/klaviyo/app/pull/116745
Nick took a first look

### @timothysheee — 2026-05-07T14:21:27Z

> I just tested on my local and I was able to add more widgets when the feature flag was on even when there would be 10 widgets if the feature flag was off. The desired behavior is that if there are 10 widgets either with the feature flag on or with it off, then the button should be disabled. You'll probably also want a new translation for if there's the temp max limit of 8 or 9 widgets (if there's 2 or 3 funnel widgets hidden) Also double check that the celery task is only processing the widgets that are visible. I just checked in Tilt and saw the by channel funnel widget even when the feature flag was off.

My initial thought was that your PR covered that exact case, so I could merge this second. However, testing is a valid point. I've added the changes that were needed to check this logic, so it can be individually tested.

I will expect to address merge conflicts before merging this


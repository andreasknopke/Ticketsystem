**Verdikt:** `approve`
**Empfohlener Coding-Level:** `medium`
_The task is a straightforward UI enhancement of an existing feature, requiring no new architectural patterns or complex cross-module interactions. It primarily involves component updates and query key adjustments._

The plan extends the existing training year view to allow selection and planning of future years. This is a natural extension of the described feature, fits within the current architecture, and does not violate any project conventions or documented constraints. The affected areas are correctly identified, and the required changes are limited to UI components and minor API adjustments.

**Integrationsrisiken:**
- Backend endpoints (training_rotations, transfer) must correctly handle dates beyond the current year; no hardcoded year restrictions should exist.
- TanStack Query keys must include the year to ensure proper cache invalidation and data separation.
- The GanttChart / YearSelector components may assume a single current year and need thorough testing with years up to 2030.

**Empfohlene Aenderungen:**
- Consider making the maximum selectable year configurable (e.g., via a system setting) rather than hardcoding 2030, to allow future adjustments without code changes.
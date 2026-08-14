# Frontend
- Console frontend is simple view-only page that allows to inspect each user object.
- There are three types of objects: key-value store, dataset, request queue.
  - For each object type there must be exactly one widget for inspection.

- It contains list view and detail view for following objects:
  - Actors
  - Actor builds
  - Actor runs
  - Logs
  - User owned storages
    - key-value stores
    - datasets
    - request queues

- List view is a list of objects that can be clicked on to open detail view.
- Detail view of an object is showing only one object with all the available data
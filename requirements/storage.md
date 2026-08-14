# Storage backend
- The system uses only Crawlee based storages.
- The system accesses storages only through Crawlee defined public methods.

# Storage objects
- The system stores:
  - internal objects, that are needed for the functionality of the system.
  - user objects, that are created by public API by the user or user's actor
- The system uses single storage space for:
  - for internal system objects
  - for internal user objects
  - for user data
- No internal objects can be accessed by the API.

## Internal objects
### Storage metadata
- The system has one internal key-value store called `__STORAGES__` to track all the storages and their metadata:
  - `key` is the id of the storage
  - `value` is the metadata of the storage
    - owner (`userId`)
    - statistics
- The system stores users in dedicated key-value store called `__USERS__`:
  - `key` is the `userId`
  - `value` is the metadata of the user
    - name
    - token
- The system stores Actors in dedicated key-value store called `__ACTORS__`:
  - `key` is the id of the Actor `actorId`
  - `value` is the metadata of the Actor
    - owner (`userId`)
    - metadata
- The system stores Actor runs in dedicated key-value store called `__RUNS__`:
  - `key` is the id of the Actor run `runId`
  - `value` is the metadata of the Actor
    - owner (`userId`)
    - Actor (`actorId`)
    - metadata
- The system stores Actor builds in dedicated key-value store called `__BUILDS__`:
  - `key` is the id of the Actor build (`buildId`)
  - `value` is the metadata of the Actor
    - owner (`userId`)
    - Actor (`actorId`)
    - metadata
- The system stores logs in dedicated key-value store called `__LOGS__`:
  - `key` is the id of the Actor build (`logId`)
  - `value` is the metadata of the Actor
    - owner (`userId`)
    - RunOrBuild (`buildId` or `runId`)
    - metadata
- The system stores all needed files in dedicated key-value store called `__FILES__`:
  - `key` is the id of the file (`fileId`)
  - `value` is the file
  - This key-value store is a flexible collection that can be referred by other internal object that needs to contain a file

### Users
- User can be created only by the system.
- There is only one default user. (In the POC)
- The user data that can be accessed by the API is a restricted view only over the objects belonging to the user.
  - The system filters all API responses to only contain user owned resources.


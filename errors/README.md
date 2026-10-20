# Error contracts

Application failures use `Exception` from `error-message-utils` and its default code `-1`. Diagnostic owner details or the extracted cause may follow the stable message. Arbitrary operation failures in `withHqLock` propagate unchanged.

| Code | Stable message                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------- |
| -1   | The HQ lock acquisition arguments are invalid                                                        |
| -1   | The HQ lock requires Linux or macOS                                                                  |
| -1   | The HQ runtime directory must be a real directory                                                    |
| -1   | The HQ runtime directory must be private and owned by the current user                               |
| -1   | The HQ lock must be a regular file                                                                   |
| -1   | The HQ lock must be private and owned by the current user                                            |
| -1   | The HQ lock owner exceeds the supported size                                                         |
| -1   | The HQ lock owner could not be read. Inspect .runtime/hq.lock                                        |
| -1   | The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped |
| -1   | The HQ lock has an inactive owner                                                                    |
| -1   | The HQ lock owner could not be verified                                                              |
| -1   | Timed out waiting for the HQ lock                                                                    |
| -1   | HQ lock ownership changed before release                                                             |
| -1   | The HQ lock is not held                                                                              |
| -1   | The HQ lock nonce does not match                                                                     |

Recovery never automatically deletes an inactive, unreadable, incomplete or unverifiable lock. Operator recovery checks the inspected nonce after the operator has established that the owner and its children stopped.

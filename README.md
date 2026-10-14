# prifly-ext-aws

Your AWS accounts in every prifly session, through the access key you filed in
prifly's Vault → Connections (Add AWS key). prifly signs every request with AWS
Signature Version 4 inside the host: this extension never holds a secret, and
needs no `aws` CLI.

Ask any session for anything you would do with the aws CLI. **Reads answer at
once. Every write shows a confirm card** (service, action, region, account,
the request and its params) **and runs only when you click Confirm.** Cancel,
and nothing is sent.

## What it gives you

- **Tools for every session** (`mcp__prifly__aws_*`):
  - `aws_api { service, action, params?, region?, account? }`: any action of any AWS service. `service` is the name the aws CLI uses (`ec2`, `s3`, `lambda`, `route53`, `elbv2`, …); `account` is a connection id, an account id or an alias (default: the only or first key); `region` defaults to `eu-north-1`. The reply is text (XML or JSON), cut to about 40 kB with the `NextToken`/`Marker` to page on. A key AWS no longer accepts comes back as text telling the reader to re-check or re-add it.
  - `aws_api_docs { service, action? }`: how to call an action, read from its botocore service model. Without `action`: the protocol, endpoint prefix, API version and the operation names. With it: how `aws_api` sends it (method and URI, or target), whether it is a read, a write or refused, its required params, and its input and output shapes a few levels deep with trimmed docs, capped at about 40 kB.
  - `aws_whoami`: the keys filed, whether each still works, and the IAM identity it is (STS `GetCallerIdentity`, kept five minutes).
  - `aws_cost { account? }`: the cached daily Cost Explorer reading. Never a live call.
- **One status line** in Settings → Extensions: `Connected · account <id> (<user>)` for the first key (with the number of keys when there are more), or what stands in the way (no key filed, the key needs signing in). Read again every 15 minutes.
- No board, launcher, flag or status-bar item.

## What `aws_api` does with a call

| | |
|---|---|
| Runs at once (a read) | `Describe*`, `List*`, `Get*`, `Search*`, `Lookup*`, `BatchGet*`; DynamoDB `Query` and `Scan`; Logs `FilterLogEvents` |
| Asks first (a write) | every other action: a confirm card through `api.confirm`; Cancel answers "Not done: you cancelled" and sends nothing. A prifly without `confirm` makes no write at all |
| Refused: reveals a secret | any `Get*` or `BatchGet*` whose name has Secret, Password, Token, Credential, AccessDetails, PrivateKey or KeyPair; every STS action but `GetCallerIdentity`; SSM `GetParameter*` with `WithDecryption`; EC2 `DescribeInstanceAttribute` for `userData`; IAM `CreateAccessKey`, `CreateServiceSpecificCredential`, `ResetServiceSpecificCredential`; EC2 and Lightsail `CreateKeyPair`, Lightsail `DownloadDefaultKeyPair`; KMS `Decrypt`, `GenerateDataKey`, `GenerateDataKeyPair`; SSO OIDC `CreateToken`; Cognito `InitiateAuth`, `AdminInitiateAuth`, `RespondToAuthChallenge`. Matched whatever the case of the action |
| Refused: costs money | every Cost Explorer (`ce`) action. Cost Explorer is read once per account per day by the extension itself (3 calls, about $0.03) |
| Redacted in replies | Lambda `Environment` variables, ECS container `environment` and `secrets`, a Lambda's signed code link, EC2 launch template `userData`: shown as `[redacted by prifly]` |

The key's IAM policy stays the backstop: what it does not allow, AWS refuses.

**How a request is built.** `sts`, `ec2`, `iam`, `rds`, `elasticloadbalancing`, `sns`, `cloudformation`, `cloudwatch`, `logs`, `dynamodb`, `ecs` and `ce` are built from a table, with no network. Every other service is built from its botocore model, the same one `aws_api_docs` reads: Query and EC2 (flattened form params), JSON 1.0/1.1 (`X-Amz-Target`), rest-json and rest-xml (each member to the URI, query string, a header or the body as the model says; a payload member is the whole body; XML named and namespaced from the model; `Content-MD5` where the model requires a checksum; an S3 bucket in the host when its name allows; global services such as IAM, Route 53 and CloudFront at their global endpoint, signed in `us-east-1`).

**The models.** The newest API version of a service is found with the GitHub contents API (`api.github.com/repos/boto/botocore/contents/botocore/data/<service>`), its `service-2.json` fetched from `raw.githubusercontent.com/boto/botocore/develop/…`, and kept in memory while prifly runs. The models come from botocore's `develop` branch, not a pinned tag, so a request's shape follows AWS's newest published model without a release of this extension.

## Background reads

- **Cost.** Once per account per UTC day: `GetCostAndUsage` (month to date, grouped by service, unblended), `GetCostForecast` to month end, and `GetCostAndUsage` for the same days of last month. Kept in `cost.json` in the extension's folder. If the key may not read Cost Explorer, or it is not enabled for the account, a note is kept instead and `aws_cost` says so; the next try is tomorrow.
- **Status.** STS `GetCallerIdentity` for the first key, every 15 minutes.

Writes, and writes not done, are written to prifly's log (`write`, `write_not_done`).

## Develop

```sh
bun install
bun test && bun run typecheck && bun run check
```

The types come from `@prifly/extension-api`, at a tag of `jimmy927/prifly-extension-api`.

| File | What it is |
|---|---|
| `aws.ts` | The table services' wire shapes (Query, JSON), `send` through `api.connections.fetch` |
| `models.ts` | The botocore models from GitHub, kept in memory |
| `model-request.ts` | Any request from its model (Query, EC2, JSON, rest-json, rest-xml) |
| `allowlist.ts` | Pure: read, write or refused, and the redaction of replies |
| `tools.ts` | `aws_whoami`, `aws_api`, `aws_api_docs`, `aws_cost`; the confirm card, trimming and paging |
| `docs.ts` | `aws_api_docs`'s text from a model |
| `accounts.ts` | The filed keys, which one a call means, identity |
| `status.ts` | The Settings → Extensions line |
| `cost.ts` | The once-a-day Cost Explorer reading and its note |
| `test/fake-aws.ts`, `test/fake-models.ts` | A fake `aws-keys` connection answering canned XML and JSON; a fake GitHub serving small models |

## License and contributing

Source-available under the Functional Source License 1.1 with an Apache 2.0 future license (`LICENSE.md`): use it, change it and fix it freely, but not to offer a competing product. Each version becomes Apache 2.0 two years after its release.

Pull requests are welcome. Before one can be merged, its author signs the contributor agreement (`CLA.md`), which assigns the copyright in the contribution to The Startup Factory AB; the CLA bot asks for it on the pull request.

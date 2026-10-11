# prifly-ext-aws

Your AWS accounts in prifly, read through the access key you filed in prifly's
Vault → Connections (Add AWS key). prifly signs every request with AWS
Signature Version 4 inside the host: this extension never holds a secret, and
needs no `aws` CLI.

**Read-only.** Nothing here changes AWS. Every call off the allowlist is
refused with a message naming the rule.

## What it gives you

- **Tools for every session** (`mcp__prifly__aws_*`):
  - `aws_whoami`: the keys filed, whether each still works, and the IAM identity it is (STS `GetCallerIdentity`, kept five minutes).
  - `aws_call { service, action, params?, region?, account? }`: one read-only API call. `account` is a connection id, an account id or an alias (default: the only or first key); `region` defaults to `eu-north-1`. The reply is text (XML or JSON), cut to about 40 kB with the `NextToken`/`Marker` to page on. A key AWS no longer accepts comes back as text telling the reader to re-check or re-add it.
  - `aws_cost { account? }`: the cached daily Cost Explorer reading. Never a live call.
- **The launcher "AWS alarms"**: one item per CloudWatch alarm in ALARM across your accounts. A picked alarm starts a session that names the alarm, account, region and metric and investigates with `aws_call` (`GetMetricData` around the state change, logs `FilterLogEvents`).
- **The panel "AWS"**: accounts and the age of each access key (a "rotate" pill over 90 days; "unknown" when IAM will not say), month-to-date cost by service with the forecast, the alarms in ALARM, and every call sessions made today, refusals included.
- **A glowing launcher button** while any alarm is in ALARM.

## What `aws_call` allows

| | |
|---|---|
| Runs | `Describe*`, `List*`, `Get*`, `Search*`, `Lookup*`, `BatchGet*`; DynamoDB `Query` and `Scan`; Logs `FilterLogEvents` |
| Refused: reveals a secret | any `Get*` whose name has Secret, Password, Token, Credential, AccessDetails, PrivateKey or KeyPair; every STS action but `GetCallerIdentity`; SSM `GetParameter*` with `WithDecryption`; EC2 `DescribeInstanceAttribute` for `userData` |
| Refused: costs money | every Cost Explorer (`ce`) action. Cost Explorer is read once per account per day by the extension itself (3 calls, about $0.03) |
| Refused: a write | everything else |
| Redacted in replies | Lambda `Environment` variables, ECS container `environment` and `secrets`, a Lambda's signed code link, EC2 launch template `userData`: shown as `[redacted by prifly]` |

Services: `sts`, `ec2`, `iam`, `rds`, `elasticloadbalancing`, `sns`, `cloudformation`, `cloudwatch`, `logs`, `dynamodb`, `ecs`; `s3` (`ListBuckets`, `ListObjectsV2`, `GetBucketLocation`); `lambda` (`ListFunctions`, `GetFunction`). An unknown service is refused with this list.

## Background reads

- **Alarms.** Once a day, per account, `ec2 DescribeRegions` and one `cloudwatch DescribeAlarms` per region find the regions that have alarms. Every five minutes only those regions are asked for `StateValue=ALARM`.
- **Cost.** Once per account per UTC day: `GetCostAndUsage` (month to date, grouped by service, unblended), `GetCostForecast` to month end, and `GetCostAndUsage` for the same days of last month. Kept in `cost.json` in the extension's folder. If the key may not read Cost Explorer, or it is not enabled for the account, a note is kept instead and the panel shows it in place of the cost tiles; the next try is tomorrow.
- **Key age.** IAM `ListAccessKeys` and `GetAccessKeyLastUsed`. prifly does not say which access key a connection holds, so it is the active one IAM saw used last.

Kept in the extension's folder: `cost.json`, `alarm-regions.json` and `calls.jsonl` (the call log, 30 days).

## Develop

```sh
bun install
bun test && bun run typecheck && bun run check
```

The types come from `@prifly/extension-api`, at a tag of `jimmy927/prifly-extension-api`.

| File | What it is |
|---|---|
| `aws.ts` | The wire shapes (Query, JSON, REST), the service table, `send` through `api.connections.fetch` |
| `allowlist.ts` | Pure: what `aws_call` may send, which rule refuses the rest, the redaction of replies |
| `tools.ts` | `aws_whoami`, `aws_call`, `aws_cost`; trimming and paging |
| `accounts.ts` | The filed keys, which one a call means, identity and key age |
| `cost.ts` | The once-a-day Cost Explorer reading and its note |
| `alarms.ts` | The daily region sweep, the five-minute poll, the launcher glow |
| `launch.ts` | The alarm board and the session a picked alarm starts |
| `calls.ts` | The 30-day call log |
| `panel.ts` | `api/accounts`, `api/cost`, `api/alarms`, `api/calls`, `api/sign-in` |
| `panel/` | The page: `index.html`, `app.js`, `format.js`, `style.css` |
| `test/fake-aws.ts` | A fake `aws-keys` connection answering canned XML and JSON, recording `region` and `service` |

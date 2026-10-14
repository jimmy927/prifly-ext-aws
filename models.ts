/**
 * The botocore service models, read from GitHub: what `aws_api_docs` explains
 * and what `aws_api` builds a request from for a service outside the table in
 * `aws.ts`. The newest API version of a service is found with the GitHub
 * contents API, its `service-2.json` fetched from raw.githubusercontent.com,
 * and each model is kept in memory for as long as prifly runs.
 */

import { AwsUsageError, normalService } from "./aws";

export type Member = {
  shape: string;
  location?: string;
  locationName?: string;
  documentation?: string;
  xmlNamespace?: { uri: string };
  xmlAttribute?: boolean;
  flattened?: boolean;
};

export type Shape = {
  type: string;
  members?: Record<string, Member>;
  required?: string[];
  member?: Member;
  key?: Member;
  value?: Member;
  payload?: string;
  enum?: string[];
  documentation?: string;
  locationName?: string;
  flattened?: boolean;
};

export type Operation = {
  name: string;
  http?: { method: string; requestUri: string };
  input?: { shape: string; locationName?: string; xmlNamespace?: { uri: string } };
  output?: { shape: string };
  documentation?: string;
  endpoint?: { hostPrefix: string };
  httpChecksumRequired?: boolean;
  httpChecksum?: { requestChecksumRequired?: boolean };
  deprecated?: boolean;
};

export type ServiceModel = {
  /** The botocore folder name, `elbv2`. */
  service: string;
  /** The API version folder it was read from, `2015-12-01`. */
  version: string;
  metadata: {
    apiVersion?: string;
    endpointPrefix: string;
    signingName?: string;
    protocol: string;
    protocols?: string[];
    jsonVersion?: string;
    targetPrefix?: string;
    globalEndpoint?: string;
    serviceFullName?: string;
  };
  operations: Record<string, Operation>;
  shapes: Record<string, Shape>;
  documentation?: string;
};

/** Plain HTTP; global `fetch` unless a test gives another. */
export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

const LIST = "https://api.github.com/repos/boto/botocore/contents/botocore/data";
const RAW = "https://raw.githubusercontent.com/boto/botocore/develop/botocore/data";
const HEADERS = { accept: "application/vnd.github+json", "user-agent": "prifly-ext-aws" };

/** The names a session may use that botocore spells otherwise. */
const BOTOCORE_NAMES: Record<string, string> = { elasticloadbalancing: "elbv2" };

/** botocore's folder name for `service`. */
export function botocoreName(service: string): string {
  const name = normalService(service);
  return BOTOCORE_NAMES[name] ?? name;
}

/** The protocols a request can be built in, best first. */
const SUPPORTED = ["json", "rest-json", "rest-xml", "query", "ec2"];

/** The protocol `aws_api` speaks to the service; null when it speaks none of them. */
export function protocolOf(model: ServiceModel): string | null {
  const listed = model.metadata.protocols ?? [model.metadata.protocol];
  return listed.find((each) => SUPPORTED.includes(each)) ?? null;
}

export class Models {
  private readonly fetch: HttpFetch;
  private readonly held = new Map<string, Promise<ServiceModel>>();

  constructor(fetch: HttpFetch = (url, init) => globalThis.fetch(url, init)) {
    this.fetch = fetch;
  }

  /** The newest model of `service`, read once; an `AwsUsageError` when botocore has no such service. */
  load(service: string): Promise<ServiceModel> {
    const name = botocoreName(service);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return Promise.reject(new AwsUsageError(`"${service}" is not an AWS service name.`));
    }
    const held = this.held.get(name);
    if (held !== undefined) return held;
    const reading = this.read(name);
    this.held.set(name, reading);
    // A failure is not kept: the next call tries again.
    reading.catch(() => this.held.delete(name));
    return reading;
  }

  private async read(name: string): Promise<ServiceModel> {
    const version = await this.newestVersion(name);
    const answer = await this.fetch(`${RAW}/${name}/${version}/service-2.json`);
    if (!answer.ok) {
      throw new Error(`GitHub answered HTTP ${answer.status} for the ${name} ${version} model.`);
    }
    const model = (await answer.json()) as Omit<ServiceModel, "service" | "version">;
    return { ...model, service: name, version };
  }

  private async newestVersion(name: string): Promise<string> {
    const answer = await this.fetch(`${LIST}/${name}`, { headers: HEADERS });
    if (answer.status === 404) {
      throw new AwsUsageError(
        `botocore has no AWS service "${name}". Use the name the aws CLI uses (ec2, s3, lambda, route53, elbv2, …).`,
      );
    }
    if (!answer.ok) {
      const why = answer.status === 403 ? " (GitHub's hourly limit, most likely)" : "";
      throw new Error(`GitHub answered HTTP ${answer.status} listing ${name}'s models${why}.`);
    }
    const entries = (await answer.json()) as { name?: unknown; type?: unknown }[];
    const versions = (Array.isArray(entries) ? entries : [])
      .filter((each) => each.type === "dir" && typeof each.name === "string")
      .map((each) => each.name as string)
      .filter((each) => /^\d{4}-\d{2}-\d{2}/.test(each))
      .sort();
    const newest = versions.at(-1);
    if (newest === undefined) throw new AwsUsageError(`botocore lists no model for "${name}".`);
    return newest;
  }
}

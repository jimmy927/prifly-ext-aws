/**
 * A fake GitHub for the botocore models: the contents API lists an old and a
 * new version folder per service, raw.githubusercontent.com answers the new
 * one's `service-2.json`. The models are small cut-downs of the real ones.
 */

import type { HttpFetch } from "../models";

type Model = Record<string, unknown>;

const S3: Model = {
  documentation: "<p>Amazon <b>S3</b> stores objects.</p>",
  metadata: {
    apiVersion: "2006-03-01",
    endpointPrefix: "s3",
    globalEndpoint: "s3.amazonaws.com",
    protocol: "rest-xml",
    protocols: ["rest-xml"],
    serviceFullName: "Amazon Simple Storage Service",
  },
  operations: {
    ListObjectsV2: {
      name: "ListObjectsV2",
      http: { method: "GET", requestUri: "/{Bucket}?list-type=2" },
      input: { shape: "ListObjectsV2Request" },
      output: { shape: "ListObjectsV2Output" },
      documentation: "<p>Returns some or all of the objects in a bucket.</p>",
    },
    GetObject: {
      name: "GetObject",
      http: { method: "GET", requestUri: "/{Bucket}/{Key+}" },
      input: { shape: "GetObjectRequest" },
    },
    PutBucketTagging: {
      name: "PutBucketTagging",
      http: { method: "PUT", requestUri: "/{Bucket}?tagging" },
      input: { shape: "PutBucketTaggingRequest" },
      httpChecksum: { requestChecksumRequired: true },
      documentation: `<p>Sets the tags for a bucket. ${"<p>Long words here.</p>".repeat(200)}`,
    },
  },
  shapes: {
    BucketName: { type: "string" },
    ObjectKey: { type: "string" },
    Prefix: { type: "string" },
    MaxKeys: { type: "integer" },
    ListObjectsV2Request: {
      type: "structure",
      required: ["Bucket"],
      members: {
        Bucket: { shape: "BucketName", location: "uri", locationName: "Bucket" },
        Prefix: {
          shape: "Prefix",
          location: "querystring",
          locationName: "prefix",
          documentation: "<p>Limits the response to keys that begin with the prefix.</p>",
        },
        MaxKeys: { shape: "MaxKeys", location: "querystring", locationName: "max-keys" },
      },
    },
    ListObjectsV2Output: {
      type: "structure",
      members: { Contents: { shape: "ObjectList" }, KeyCount: { shape: "MaxKeys" } },
    },
    ObjectList: { type: "list", member: { shape: "Object" }, flattened: true },
    Object: {
      type: "structure",
      members: { Key: { shape: "ObjectKey" }, StorageClass: { shape: "StorageClass" } },
    },
    StorageClass: {
      type: "string",
      enum: [
        "STANDARD",
        "REDUCED_REDUNDANCY",
        "GLACIER",
        "STANDARD_IA",
        "ONEZONE_IA",
        "INTELLIGENT_TIERING",
        "DEEP_ARCHIVE",
        "OUTPOSTS",
        "GLACIER_IR",
      ],
    },
    GetObjectRequest: {
      type: "structure",
      required: ["Bucket", "Key"],
      members: {
        Bucket: { shape: "BucketName", location: "uri", locationName: "Bucket" },
        Key: { shape: "ObjectKey", location: "uri", locationName: "Key" },
        Range: { shape: "Prefix", location: "header", locationName: "Range" },
      },
    },
    PutBucketTaggingRequest: {
      type: "structure",
      required: ["Bucket", "Tagging"],
      members: {
        Bucket: { shape: "BucketName", location: "uri", locationName: "Bucket" },
        Tagging: {
          shape: "Tagging",
          locationName: "Tagging",
          xmlNamespace: { uri: "http://s3.amazonaws.com/doc/2006-03-01/" },
        },
      },
      payload: "Tagging",
    },
    Tagging: { type: "structure", required: ["TagSet"], members: { TagSet: { shape: "TagSet" } } },
    TagSet: { type: "list", member: { shape: "Tag", locationName: "Tag" } },
    Tag: {
      type: "structure",
      required: ["Key", "Value"],
      members: { Key: { shape: "ObjectKey" }, Value: { shape: "Prefix" } },
    },
  },
};

const LAMBDA: Model = {
  metadata: {
    apiVersion: "2015-03-31",
    endpointPrefix: "lambda",
    protocol: "rest-json",
    protocols: ["rest-json"],
    signingName: "lambda",
  },
  operations: {
    ListFunctions: {
      name: "ListFunctions",
      http: { method: "GET", requestUri: "/2015-03-31/functions/" },
      input: { shape: "ListFunctionsRequest" },
    },
    UpdateFunctionConfiguration: {
      name: "UpdateFunctionConfiguration",
      http: { method: "PUT", requestUri: "/2015-03-31/functions/{FunctionName}/configuration" },
      input: { shape: "UpdateFunctionConfigurationRequest" },
    },
    Invoke: {
      name: "Invoke",
      http: { method: "POST", requestUri: "/2015-03-31/functions/{FunctionName}/invocations" },
      input: { shape: "InvocationRequest" },
    },
  },
  shapes: {
    Name: { type: "string" },
    Count: { type: "integer" },
    Blob: { type: "blob" },
    ListFunctionsRequest: {
      type: "structure",
      members: {
        Marker: { shape: "Name", location: "querystring", locationName: "Marker" },
        MaxItems: { shape: "Count", location: "querystring", locationName: "MaxItems" },
      },
    },
    UpdateFunctionConfigurationRequest: {
      type: "structure",
      required: ["FunctionName"],
      members: {
        FunctionName: { shape: "Name", location: "uri", locationName: "FunctionName" },
        Timeout: { shape: "Count" },
        Description: { shape: "Name" },
      },
    },
    InvocationRequest: {
      type: "structure",
      required: ["FunctionName"],
      members: {
        FunctionName: { shape: "Name", location: "uri", locationName: "FunctionName" },
        InvocationType: {
          shape: "Name",
          location: "header",
          locationName: "X-Amz-Invocation-Type",
        },
        Payload: { shape: "Blob" },
      },
      payload: "Payload",
    },
  },
};

const KINESIS: Model = {
  metadata: {
    apiVersion: "2013-12-02",
    endpointPrefix: "kinesis",
    jsonVersion: "1.1",
    protocol: "json",
    protocols: ["json"],
    targetPrefix: "Kinesis_20131202",
  },
  operations: {
    ListStreams: { name: "ListStreams", input: { shape: "ListStreamsInput" } },
    DeleteStream: { name: "DeleteStream", input: { shape: "DeleteStreamInput" } },
  },
  shapes: {
    Name: { type: "string" },
    ListStreamsInput: { type: "structure", members: { Limit: { shape: "Name" } } },
    DeleteStreamInput: {
      type: "structure",
      required: ["StreamName"],
      members: { StreamName: { shape: "Name" } },
    },
  },
};

const ROUTE53: Model = {
  metadata: {
    apiVersion: "2013-04-01",
    endpointPrefix: "route53",
    globalEndpoint: "route53.amazonaws.com",
    protocol: "rest-xml",
    protocols: ["rest-xml"],
  },
  operations: {
    ListHostedZones: {
      name: "ListHostedZones",
      http: { method: "GET", requestUri: "/2013-04-01/hostedzone" },
      input: { shape: "ListHostedZonesRequest" },
    },
  },
  shapes: {
    Name: { type: "string" },
    ListHostedZonesRequest: {
      type: "structure",
      members: { Marker: { shape: "Name", location: "querystring", locationName: "marker" } },
    },
  },
};

/** A model whose shapes refer to themselves, deeper than the docs go. */
const DEEP: Model = {
  metadata: {
    apiVersion: "2020-01-01",
    endpointPrefix: "deep",
    protocol: "json",
    targetPrefix: "Deep",
  },
  operations: { GetTree: { name: "GetTree", input: { shape: "Node" }, output: { shape: "L1" } } },
  shapes: {
    Text: { type: "string" },
    Node: {
      type: "structure",
      members: { Name: { shape: "Text" }, Children: { shape: "NodeList" } },
    },
    NodeList: { type: "list", member: { shape: "Node" } },
    L1: { type: "structure", members: { Next: { shape: "L2" } } },
    L2: { type: "structure", members: { Next: { shape: "L3" } } },
    L3: { type: "structure", members: { Next: { shape: "L4" } } },
    L4: { type: "structure", members: { Next: { shape: "L5" } } },
    L5: { type: "structure", members: { Next: { shape: "L6" } } },
    L6: { type: "structure", members: { Leaf: { shape: "Text" } } },
  },
};

export const MODELS: Record<string, { version: string; model: Model }> = {
  s3: { version: "2006-03-01", model: S3 },
  lambda: { version: "2015-03-31", model: LAMBDA },
  kinesis: { version: "2013-12-02", model: KINESIS },
  route53: { version: "2013-04-01", model: ROUTE53 },
  deep: { version: "2020-01-01", model: DEEP },
};

const LIST = "https://api.github.com/repos/boto/botocore/contents/botocore/data/";
const RAW = "https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/";

/** The fake GitHub, and every URL it was asked for. */
export function fakeGithub(models = MODELS): { fetch: HttpFetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: HttpFetch = async (url) => {
    urls.push(url);
    if (url.startsWith(LIST)) {
      const found = models[url.slice(LIST.length)];
      if (found === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
      return Response.json([
        { name: "2001-01-01", type: "dir" },
        { name: found.version, type: "dir" },
        { name: "examples-1.json", type: "file" },
      ]);
    }
    if (url.startsWith(RAW)) {
      const [service, version] = url.slice(RAW.length).split("/");
      const found = models[service ?? ""];
      if (found === undefined || found.version !== version)
        return new Response("", { status: 404 });
      return Response.json(found.model);
    }
    return new Response("", { status: 404 });
  };
  return { fetch, urls };
}

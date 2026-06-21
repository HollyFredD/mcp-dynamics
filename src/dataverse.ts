import { AzureCliCredential } from "@azure/identity";
import axios, { type AxiosInstance } from "axios";

const INSTANCE_URL = "https://servicenow.crm.dynamics.com";
const API_VERSION = "v9.2";
const BASE_URL = `${INSTANCE_URL}/api/data/${API_VERSION}`;
const SCOPE = `${INSTANCE_URL}/.default`;

const credential = new AzureCliCredential();

async function getToken(): Promise<string> {
  const token = await credential.getToken(SCOPE);
  if (!token) throw new Error("Unable to acquire Azure CLI token. Run `az login` first.");
  return token.token;
}

let client: AxiosInstance | null = null;

export async function getClient(): Promise<AxiosInstance> {
  const token = await getToken();
  client = axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
      "Content-Type": "application/json",
      Prefer: "odata.include-annotations=*",
    },
  });
  return client;
}

export interface QueryOptions {
  entity: string;
  filter?: string;
  select?: string[];
  expand?: string[];
  orderby?: string;
  top?: number;
  skip?: number;
  fetchxml?: string;
}

export interface QueryResult {
  value: Record<string, unknown>[];
  "@odata.nextLink"?: string;
  "@odata.count"?: number;
}

export async function queryRecords(opts: QueryOptions): Promise<QueryResult> {
  const api = await getClient();

  if (opts.fetchxml) {
    const params = new URLSearchParams({ fetchXml: opts.fetchxml });
    const res = await api.get<QueryResult>(`/${opts.entity}?${params}`);
    return res.data;
  }

  const params: Record<string, string> = {};
  if (opts.filter) params["$filter"] = opts.filter;
  if (opts.select?.length) params["$select"] = opts.select.join(",");
  if (opts.expand?.length) params["$expand"] = opts.expand.join(",");
  if (opts.orderby) params["$orderby"] = opts.orderby;
  if (opts.top != null) params["$top"] = String(opts.top);
  if (opts.skip != null) params["$skip"] = String(opts.skip);

  const qs = new URLSearchParams(params).toString();
  const url = `/${opts.entity}${qs ? `?${qs}` : ""}`;
  const res = await api.get<QueryResult>(url);
  return res.data;
}

export async function getRecord(
  entity: string,
  id: string,
  select?: string[]
): Promise<Record<string, unknown>> {
  const api = await getClient();
  const qs = select?.length ? `?$select=${select.join(",")}` : "";
  const res = await api.get<Record<string, unknown>>(`/${entity}(${id})${qs}`);
  return res.data;
}

export async function createRecord(
  entity: string,
  data: Record<string, unknown>
): Promise<string> {
  const api = await getClient();
  const res = await api.post(`/${entity}`, data, {
    headers: { Prefer: "return=representation" },
  });
  // OData returns the created record ID in the Location header
  const location: string = res.headers["odata-entityid"] || res.headers["location"] || "";
  const match = location.match(/\(([^)]+)\)$/);
  return match?.[1] ?? (res.data as Record<string, unknown>)["@odata.id"] as string ?? "";
}

export async function updateRecord(
  entity: string,
  id: string,
  data: Record<string, unknown>
): Promise<void> {
  const api = await getClient();
  await api.patch(`/${entity}(${id})`, data);
}

export async function deleteRecord(entity: string, id: string): Promise<void> {
  const api = await getClient();
  await api.delete(`/${entity}(${id})`);
}

export async function getEntityMetadata(
  entity: string
): Promise<Record<string, unknown>> {
  const api = await getClient();
  const res = await api.get<Record<string, unknown>>(
    `/EntityDefinitions(LogicalName='${entity}')?$select=LogicalName,DisplayName,PrimaryIdAttribute,PrimaryNameAttribute`
  );
  return res.data;
}

export async function listEntities(): Promise<{ logicalName: string; displayName: string }[]> {
  const api = await getClient();
  const res = await api.get<{
    value: { LogicalName: string; DisplayCollectionName: { UserLocalizedLabel: { Label: string } } }[];
  }>(
    "/EntityDefinitions?$select=LogicalName,DisplayCollectionName&$filter=IsCustomizable/Value eq true or IsIntersect eq false"
  );
  return res.data.value.map((e) => ({
    logicalName: e.LogicalName,
    displayName: e.DisplayCollectionName?.UserLocalizedLabel?.Label ?? e.LogicalName,
  }));
}

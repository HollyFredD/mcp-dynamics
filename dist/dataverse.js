import { AzureCliCredential } from "@azure/identity";
import axios from "axios";
const INSTANCE_URL = "https://servicenow.crm.dynamics.com";
const API_VERSION = "v9.2";
const BASE_URL = `${INSTANCE_URL}/api/data/${API_VERSION}`;
const SCOPE = `${INSTANCE_URL}/.default`;
const credential = new AzureCliCredential();
async function getToken() {
    const token = await credential.getToken(SCOPE);
    if (!token)
        throw new Error("Unable to acquire Azure CLI token. Run `az login` first.");
    return token.token;
}
let client = null;
export async function getClient() {
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
export async function queryRecords(opts) {
    const api = await getClient();
    if (opts.fetchxml) {
        const params = new URLSearchParams({ fetchXml: opts.fetchxml });
        const res = await api.get(`/${opts.entity}?${params}`);
        return res.data;
    }
    const params = {};
    if (opts.filter)
        params["$filter"] = opts.filter;
    if (opts.select?.length)
        params["$select"] = opts.select.join(",");
    if (opts.expand?.length)
        params["$expand"] = opts.expand.join(",");
    if (opts.orderby)
        params["$orderby"] = opts.orderby;
    if (opts.top != null)
        params["$top"] = String(opts.top);
    if (opts.skip != null)
        params["$skip"] = String(opts.skip);
    const qs = new URLSearchParams(params).toString();
    const url = `/${opts.entity}${qs ? `?${qs}` : ""}`;
    const res = await api.get(url);
    return res.data;
}
export async function getRecord(entity, id, select) {
    const api = await getClient();
    const qs = select?.length ? `?$select=${select.join(",")}` : "";
    const res = await api.get(`/${entity}(${id})${qs}`);
    return res.data;
}
export async function createRecord(entity, data) {
    const api = await getClient();
    const res = await api.post(`/${entity}`, data, {
        headers: { Prefer: "return=representation" },
    });
    // OData returns the created record ID in the Location header
    const location = res.headers["odata-entityid"] || res.headers["location"] || "";
    const match = location.match(/\(([^)]+)\)$/);
    return match?.[1] ?? res.data["@odata.id"] ?? "";
}
export async function updateRecord(entity, id, data) {
    const api = await getClient();
    await api.patch(`/${entity}(${id})`, data);
}
export async function deleteRecord(entity, id) {
    const api = await getClient();
    await api.delete(`/${entity}(${id})`);
}
export async function getEntityMetadata(entity) {
    const api = await getClient();
    const res = await api.get(`/EntityDefinitions(LogicalName='${entity}')?$select=LogicalName,DisplayName,PrimaryIdAttribute,PrimaryNameAttribute`);
    return res.data;
}
export async function listEntities() {
    const api = await getClient();
    const res = await api.get("/EntityDefinitions?$select=LogicalName,DisplayCollectionName&$filter=IsCustomizable/Value eq true or IsIntersect eq false");
    return res.data.value.map((e) => ({
        logicalName: e.LogicalName,
        displayName: e.DisplayCollectionName?.UserLocalizedLabel?.Label ?? e.LogicalName,
    }));
}

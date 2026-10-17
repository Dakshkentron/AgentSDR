import { NextRequest, NextResponse } from "next/server";
import { listPeoplePage, listPeopleIds } from "@/lib/leads/records";
import { deletePeople } from "@/lib/leads/deletePeople";
import { upsertManualPerson } from "@/lib/leads/manualImport";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { parsePeopleFilters } from "./parseFilters";

export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, () => listPeople(req));
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}

async function listPeople(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
  const offset = Number(req.nextUrl.searchParams.get("offset") ?? 0);
  const sort = req.nextUrl.searchParams.get("sort");
  const direction = req.nextUrl.searchParams.get("direction");
  const result = await listPeoplePage({
    ...parsePeopleFilters(req.nextUrl.searchParams),
    limit,
    offset,
    sort: sort === "name" || sort === "title" || sort === "email" || sort === "company" || sort === "updated" || sort === "created" ? sort : undefined,
    direction: direction === "asc" || direction === "desc" ? direction : undefined,
  });
  return NextResponse.json({ people: result.rows, total: result.total });
}

export async function POST(req: NextRequest) {
  try {
    return await withOrgContext(req, () => createPerson(req));
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}

async function createPerson(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body is required" }, { status: 400 });
  try {
    const result = await upsertManualPerson({
      email: typeof body.email === "string" ? body.email : null,
      linkedinUrl: typeof body.linkedinUrl === "string" ? body.linkedinUrl : null,
      fullName: typeof body.fullName === "string" ? body.fullName : null,
      firstName: typeof body.firstName === "string" ? body.firstName : null,
      lastName: typeof body.lastName === "string" ? body.lastName : null,
      title: typeof body.title === "string" ? body.title : null,
      companyName: typeof body.companyName === "string" ? body.companyName : null,
      companyDomain: typeof body.companyDomain === "string" ? body.companyDomain : null,
      notes: typeof body.notes === "string" ? body.notes : null,
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

/** Bulk delete: `{ ids: string[] }`, or `{ matchFilters: true, filters: {...} }` for "select all N matching". */
export async function DELETE(req: NextRequest) {
  try {
    return await withOrgContext(req, () => bulkDeletePeople(req));
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}

async function bulkDeletePeople(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ ok: false, error: "JSON body is required" }, { status: 400 });

  try {
    if (body.matchFilters === true) {
      const filters = body.filters && typeof body.filters === "object" ? body.filters : {};
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
      }
      const ids = await listPeopleIds(parsePeopleFilters(params));
      const deleted = await deletePeople(ids);
      return NextResponse.json({ ok: true, deleted });
    }

    const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0) : [];
    if (!ids.length) return NextResponse.json({ ok: false, error: "ids array or matchFilters required" }, { status: 400 });
    const deleted = await deletePeople(ids);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

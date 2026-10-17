import { NextRequest, NextResponse } from "next/server";
import { listPeopleIds } from "@/lib/leads/records";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { parsePeopleFilters } from "../parseFilters";

/** Every Person id matching the current filters — backs "select all N matching" in the bulk action bar. */
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, async () => {
      const ids = await listPeopleIds(parsePeopleFilters(req.nextUrl.searchParams));
      return NextResponse.json({ ok: true, ids, total: ids.length });
    });
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}

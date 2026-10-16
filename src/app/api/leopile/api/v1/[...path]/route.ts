import { handleLeopile } from "@/lib/leopile/api";

// Leopile's Unipile-shaped API. Public in proxy.ts; every request authenticates itself with the workspace access token.
type Ctx = { params: Promise<{ path: string[] }> };

const handle = async (request: Request, { params }: Ctx) => handleLeopile(request, (await params).path);

export { handle as GET, handle as POST, handle as DELETE };

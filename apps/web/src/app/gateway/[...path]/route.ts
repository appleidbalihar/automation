import { NextRequest, NextResponse } from "next/server";

function internalGatewayBase(): string {
  return (process.env.WEB_INTERNAL_API_BASE_URL ?? "https://api-gateway:4000").trim().replace(/\/+$/, "");
}

async function proxyRequest(request: NextRequest, path: string[]): Promise<NextResponse> {
  try {
    const base = internalGatewayBase();
    const upstreamUrl = new URL(`${base}/${path.join("/")}`);
    request.nextUrl.searchParams.forEach((value, key) => {
      upstreamUrl.searchParams.set(key, value);
    });

    const headers = new Headers();
    const authorization = request.headers.get("authorization");
    if (authorization) {
      headers.set("authorization", authorization);
    }
    const contentType = request.headers.get("content-type");
    if (contentType) {
      headers.set("content-type", contentType);
    }

    const method = request.method.toUpperCase();
    const hasBody = !["GET", "HEAD"].includes(method);
    const body = hasBody ? await request.arrayBuffer() : undefined;

    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      cache: "no-store"
    });

    const responseHeaders = new Headers();
    const upstreamContentType = upstream.headers.get("content-type");
    if (upstreamContentType) {
      responseHeaders.set("content-type", upstreamContentType);
    }

    const bytes = await upstream.arrayBuffer();
    return new NextResponse(bytes, {
      status: upstream.status,
      headers: responseHeaders
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "UPSTREAM_GATEWAY_UNAVAILABLE",
        details: error instanceof Error ? error.message : "Proxy request failed"
      },
      { status: 502 }
    );
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const params = await context.params;
  return proxyRequest(request, params.path ?? []);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const params = await context.params;
  return proxyRequest(request, params.path ?? []);
}

export async function PUT(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const params = await context.params;
  return proxyRequest(request, params.path ?? []);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const params = await context.params;
  return proxyRequest(request, params.path ?? []);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const params = await context.params;
  return proxyRequest(request, params.path ?? []);
}

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

function createPermissionProxy() {
    return new Proxy({}, {
        get: (_, prop) => String(prop)
    });
}

function createAdminAuthMock(overrides = {}) {
    const adminUser = overrides.adminUser || {
        _id: '507f1f77bcf86cd799439011',
        email: 'admin@test.local',
        role: 'admin'
    };

    const requireAdminPermission = () => (req, res, next) => {
        const auth = req.headers.authorization;

        if (!auth) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        if (auth === 'Bearer invalid') {
            return res.status(401).json({ success: false, error: 'Invalid authentication token' });
        }

        if (auth === 'Bearer user') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }

        req.user = { userId: adminUser._id };
        req.adminUser = adminUser;
        return next();
    };

    return {
        requireAdmin: requireAdminPermission(),
        requireAdminPermission
    };
}

function createDoc(initial = {}) {
    const doc = {
        ...initial,
        saveCalls: 0,
        async save() {
            this.saveCalls += 1;
            return this;
        }
    };

    return doc;
}

function createSubdocCollection(items = []) {
    const list = [...items];
    list.id = (id) => list.find((item) => item._id === id) || null;
    return list;
}

function createFlagSubdoc(initial = {}) {
    return {
        ...initial,
        deleted: false,
        deleteOne() {
            this.deleted = true;
        }
    };
}

function withMockedModules(mocks, loader) {
    const previous = [];

    for (const [relativePath, exports] of Object.entries(mocks)) {
        const resolved = require.resolve(path.join(ROOT, relativePath));
        previous.push([resolved, require.cache[resolved]]);
        require.cache[resolved] = {
            id: resolved,
            filename: resolved,
            loaded: true,
            exports
        };
    }

    try {
        return loader();
    } finally {
        for (const [resolved, cached] of previous.reverse()) {
            delete require.cache[resolved];
            if (cached) {
                require.cache[resolved] = cached;
            }
        }
    }
}

function createRouteCollector() {
    const routes = [];
    const app = {};

    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        app[method] = (routePath, ...handlers) => {
            routes.push({ method: method.toUpperCase(), routePath, handlers });
        };
    }

    return { app, routes };
}

function matchRoute(pattern, actualPath) {
    const patternParts = pattern.split('/').filter(Boolean);
    const actualParts = actualPath.split('/').filter(Boolean);

    if (patternParts.length !== actualParts.length) {
        return null;
    }

    const params = {};
    for (let index = 0; index < patternParts.length; index += 1) {
        const expected = patternParts[index];
        const received = actualParts[index];

        if (expected.startsWith(':')) {
            params[expected.slice(1)] = received;
            continue;
        }

        if (expected !== received) {
            return null;
        }
    }

    return params;
}

async function invokeRoute(routes, method, rawPath, { token = 'admin', body, headers = {} } = {}) {
    const url = new URL(`http://test.local${rawPath}`);
    const pathname = url.pathname;
    const route = routes.find((entry) => entry.method === method && matchRoute(entry.routePath, pathname));

    if (!route) {
        throw new Error(`No route registered for ${method} ${pathname}`);
    }

    const reqHeaders = {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
    };

    const req = {
        method,
        url: rawPath,
        path: pathname,
        originalUrl: rawPath,
        headers: reqHeaders,
        body,
        params: matchRoute(route.routePath, pathname),
        query: Object.fromEntries(url.searchParams.entries()),
        ip: '127.0.0.1',
        get(name) {
            return this.headers[String(name).toLowerCase()];
        }
    };

    const res = {
        statusCode: 200,
        headers: {},
        payload: undefined,
        finished: false,
        status(code) {
            this.statusCode = code;
            return this;
        },
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        getHeader(name) {
            return this.headers[String(name).toLowerCase()];
        },
        json(payload) {
            this.payload = payload;
            this.finished = true;
            return this;
        },
        send(payload) {
            this.payload = payload;
            this.finished = true;
            return this;
        }
    };

    async function runHandler(index) {
        if (index >= route.handlers.length || res.finished) {
            return;
        }

        const handler = route.handlers[index];
        let nextCalled = false;

        await new Promise((resolve, reject) => {
            const next = (error) => {
                if (error) {
                    reject(error);
                    return;
                }
                nextCalled = true;
                resolve();
            };

            try {
                Promise.resolve(handler(req, res, next))
                    .then(() => {
                        if (!nextCalled || handler.length < 3) {
                            resolve();
                        }
                    })
                    .catch(reject);
            } catch (error) {
                reject(error);
            }
        });

        if (nextCalled) {
            await runHandler(index + 1);
        }
    }

    await runHandler(0);
    return { response: { status: res.statusCode }, json: res.payload, headers: res.headers };
}

async function withRouteApp({ routeModulePath, mocks }, run) {
    return withMockedModules(mocks, async () => {
        const resolvedRoute = require.resolve(path.join(ROOT, routeModulePath));
        delete require.cache[resolvedRoute];
        const registerRoutes = require(resolvedRoute);
        const { app, routes } = createRouteCollector();
        registerRoutes(app);

        try {
            return await run({
                request: (method, routePath, options) => invokeRoute(routes, method, routePath, options)
            });
        } finally {
            delete require.cache[resolvedRoute];
        }
    });
}

function createRouteTestContext() {
    const auditCalls = [];
    const securityCalls = [];
    const emailCalls = [];

    return {
        auditCalls,
        securityCalls,
        emailCalls,
        adminAuth: createAdminAuthMock(),
        auditService: {
            async recordAdminAction(payload) {
                auditCalls.push(payload);
                return { _id: 'audit-1', ...payload };
            }
        },
        emailService: {
            async sendVerificationEmail(...args) {
                emailCalls.push({ type: 'verification', args });
            },
            async sendPasswordResetEmail(...args) {
                emailCalls.push({ type: 'password-reset', args });
            }
        },
        securityService: {
            async revokeAllUserSessions(...args) {
                securityCalls.push({ type: 'revoke-all', args });
                return [];
            },
            async recordSecurityEvent(payload) {
                securityCalls.push({ type: 'security-event', payload });
                return { _id: 'security-1', ...payload };
            }
        }
    };
}

module.exports = {
    ROOT,
    createAdminAuthMock,
    createDoc,
    createFlagSubdoc,
    createPermissionProxy,
    createRouteTestContext,
    createSubdocCollection,
    withMockedModules,
    withRouteApp
};

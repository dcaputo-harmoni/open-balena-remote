"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var url_1 = require("url");
var express_1 = __importDefault(require("express"));
var cookie_parser_1 = __importDefault(require("cookie-parser"));
var child_process_1 = require("child_process");
var http_proxy_middleware_1 = require("http-proxy-middleware");
var portfinder_1 = __importDefault(require("portfinder"));
var express_session_1 = __importDefault(require("express-session"));
var memorystore_1 = __importDefault(require("memorystore"));
var util_1 = __importDefault(require("util"));
var wait_port_1 = __importDefault(require("wait-port"));
var fs_1 = __importDefault(require("fs"));
var dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
var DEBUG = true;
var PORT = 80;
var HOST = '0.0.0.0';
var COOKIE_SECRET = 'bFzjy5TSpypevdWljWspkAqxl8QQSTLG';
var ERROR_PATH = '/error.html';
var routes = {
    tunnel: {
        route: 'protocol://127.0.0.1:tunnel',
    },
    vnc: {
        remotePort: 5900,
        serverCmd: '/usr/local/bin/websockify --web /usr/share/novnc_root localPort 127.0.0.1:tunnelPort',
        serverPath: '/novnc/vnc.html?autoconnect=true&reconnect=true&reconnect_delay=10',
        route: 'http://127.0.0.1:server',
    },
    ssh: {
        remotePort: 22222,
        serverPath: '/ttyd/?arg=port&arg=uuid&arg=container&arg=username&arg=sessionDir',
        route: 'http://127.0.0.1:7681',
    },
};
var loginCmd = '/usr/bin/balena login --token apiKey';
var tunnelCmd = '/usr/bin/balena tunnel uuid -p remotePort:127.0.0.1:localPort';
var killCmd = 'kill -9 pid';
var MemoryStore = (0, memorystore_1.default)(express_session_1.default);
var sessionStore = new MemoryStore({
    checkPeriod: 24 * 60 * 60 * 1000,
});
var sessionStoreAll = util_1.default.promisify(sessionStore.all.bind(sessionStore));
var sessionStoreGet = util_1.default.promisify(sessionStore.get.bind(sessionStore));
var sessionStoreDestroy = util_1.default.promisify(sessionStore.destroy.bind(sessionStore));
var sessionParams = {
    secret: COOKIE_SECRET,
    cookie: {
        secure: process.env.HOST_MODE === 'secure',
        sameSite: 'none',
        maxAge: 6 * 60 * 60 * 1000,
    },
    store: sessionStore,
    resave: false,
    saveUninitialized: true,
};
var expressServers = {};
var scheduledCleanups = {};
function initialRequestHandler(req, res, next) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, sessionID, _b, _c, service, port, uuid, jwt, apiKey, privateKey, protocol, ttlSecs, remotePort, _d, _e, portOpen, renderPath, _f, _g, cookieParams, err_1;
        var _h, _j;
        return __generator(this, function (_k) {
            switch (_k.label) {
                case 0:
                    _a = req._parsedUrl.pathname;
                    switch (_a) {
                        case '/endSession': return [3, 1];
                    }
                    return [3, 4];
                case 1:
                    sessionID = req.query.sessionID;
                    _b = sessionID;
                    if (!_b) return [3, 3];
                    return [4, sessionStoreGet(sessionID)];
                case 2:
                    _b = (_k.sent());
                    _k.label = 3;
                case 3:
                    if (_b) {
                        if (DEBUG)
                            console.log("Received request to delete session: ".concat(sessionID));
                        cleanupSession.bind({ sessionID: sessionID })();
                        res.sendStatus(200).end();
                    }
                    return [3, 20];
                case 4:
                    _c = req.query, service = _c.service, port = _c.port, uuid = _c.uuid, jwt = _c.jwt, apiKey = _c.apiKey, privateKey = _c.privateKey, protocol = _c.protocol, ttlSecs = _c.ttlSecs;
                    if (!(service && routes[service])) return [3, 19];
                    _k.label = 5;
                case 5:
                    _k.trys.push([5, 17, , 18]);
                    return [4, req.session.regenerate(function (err) {
                            if (err)
                                console.log(err);
                            req.session.foo = 'bar';
                            req.session.data = {};
                            req.session.save(function (e) { return (e ? console.log(e) : void 0); });
                        })];
                case 6:
                    _k.sent();
                    console.log('INITIAL SESSION');
                    console.log(req.session);
                    try {
                        console.log(req.session.id);
                    }
                    catch (e) {
                        console.log('NO SESSION ID');
                    }
                    req.session.data.activeService = service;
                    req.session.data.sessionDir = "/tmp/".concat(req.session.id);
                    if (!fs_1.default.existsSync(req.session.data.sessionDir)) {
                        fs_1.default.mkdirSync(req.session.data.sessionDir);
                    }
                    if (!jwt && !apiKey) {
                        throw Error('At least one of jwt or apiKey must be specified');
                    }
                    if (!jwt) return [3, 7];
                    fs_1.default.writeFileSync("".concat(req.session.data.sessionDir, "/token"), jwt);
                    return [3, 9];
                case 7: return [4, executeCommand(loginCmd, {
                        apiKey: apiKey,
                    }, { BALENARC_DATA_DIRECTORY: req.session.data.sessionDir }, false)];
                case 8:
                    _k.sent();
                    _k.label = 9;
                case 9:
                    remotePort = routes[service].remotePort
                        ? routes[service].remotePort
                        : port;
                    if (!remotePort) {
                        throw Error('Port must be provided to tunnel');
                    }
                    _d = req.session.data;
                    _h = {};
                    return [4, portfinder_1.default.getPortPromise({
                            port: 20000,
                            stopPort: 29999,
                        })];
                case 10:
                    _d.tunnel = (_h.port = _k.sent(),
                        _h);
                    _e = req.session.data.tunnel;
                    return [4, executeCommand(tunnelCmd, {
                            uuid: uuid,
                            remotePort: remotePort,
                            localPort: req.session.data.tunnel.port,
                            tunnelID: req.session.data.tunnel.id,
                        }, { BALENARC_DATA_DIRECTORY: req.session.data.sessionDir }, true)];
                case 11:
                    _e.pid = _k.sent();
                    return [4, (0, wait_port_1.default)({
                            host: '127.0.0.1',
                            port: req.session.data.tunnel.port,
                            timeout: 10 * 1000,
                        })];
                case 12:
                    portOpen = _k.sent();
                    if (!portOpen) {
                        throw Error('Unable to open VPN tunnel');
                    }
                    if (DEBUG)
                        console.log("Opened VPN tunnel from 127.0.0.1:".concat(req.session.data.tunnel.port, " to remote device ").concat(uuid, ":").concat(remotePort, " with PID ").concat(req.session.data.tunnel.pid));
                    renderPath = "".concat(req.protocol, "://").concat(req.headers.host.split(':')[0], ":").concat(PORT);
                    if (!routes[service].serverCmd) return [3, 16];
                    _f = req.session.data;
                    _j = {};
                    return [4, portfinder_1.default.getPortPromise({
                            port: 30000,
                            stopPort: 39999,
                        })];
                case 13:
                    _f.server = (_j.port = _k.sent(),
                        _j);
                    _g = req.session.data.server;
                    return [4, executeCommand(routes[service].serverCmd, {
                            localPort: req.session.data.server.port,
                            remotePort: remotePort,
                            tunnelPort: req.session.data.tunnel.port,
                        }, {}, true)];
                case 14:
                    _g.pid = _k.sent();
                    return [4, (0, wait_port_1.default)({
                            host: '127.0.0.1',
                            port: req.session.data.server.port,
                            timeout: 10 * 1000,
                        })];
                case 15:
                    portOpen = _k.sent();
                    if (!portOpen) {
                        throw Error('Unable to start server');
                    }
                    if (DEBUG)
                        console.log(req.session.data.server.port == ''
                            ? 'No server was started as this is a proxy request only'
                            : "Started server at 127.0.0.1:".concat(req.session.data.server.port, " with PID ").concat(req.session.data.server.pid));
                    _k.label = 16;
                case 16:
                    if (routes[service].serverPath) {
                        renderPath += routes[service].serverPath.replace(/port|uuid|container|username|sessionDir/gi, function (matched) {
                            return ((req.query[matched]
                                ? encodeURIComponent(req.query[matched])
                                : req.session.data.server
                                    ? req.session.data.server[matched]
                                    : req.session.data.tunnel[matched]) ||
                                req.session.data[matched] ||
                                '');
                        });
                        if (privateKey) {
                            fs_1.default.writeFileSync("".concat(req.session.data.sessionDir, "/privateKey"), privateKey);
                            fs_1.default.chmodSync("".concat(req.session.data.sessionDir, "/privateKey"), '0600');
                        }
                    }
                    else {
                        if (protocol) {
                            req.session.data.protocol = protocol;
                        }
                        [
                            'service',
                            'apiKey',
                            'uuid',
                            'container',
                            'port',
                            'protocol',
                        ].forEach(function (item) { return delete req.query[item]; });
                        renderPath += "".concat(req._parsedUrl.pathname, "?").concat(new url_1.URLSearchParams(req.query).toString());
                    }
                    cookieParams = sessionParams.cookie;
                    if (ttlSecs) {
                        cookieParams.maxAge = parseInt(ttlSecs) * 1000;
                    }
                    if (DEBUG)
                        console.log("Rendering iframe with path: ".concat(renderPath));
                    req.session.save(function (err) { return (err ? console.log(err) : void 0); });
                    res.render('iframe', { iframe_source: renderPath });
                    return [3, 18];
                case 17:
                    err_1 = _k.sent();
                    next(err_1);
                    return [3, 18];
                case 18: return [3, 20];
                case 19:
                    next();
                    _k.label = 20;
                case 20: return [2];
            }
        });
    });
}
var proxyMiddlewareConfig = {
    target: '',
    changeOrigin: true,
    secure: false,
    ws: true,
    router: function (req) { return __awaiter(void 0, void 0, void 0, function () {
        var route;
        return __generator(this, function (_a) {
            if (DEBUG)
                console.log("Received proxy request at ".concat(req.protocol ? req.protocol : 'ws', "://").concat(req.rawHeaders[(req.rawHeaders.indexOf('host') !== -1
                    ? req.rawHeaders.indexOf('host')
                    : req.rawHeaders.indexOf('Host')) + 1]).concat(req.url));
            console.log('PROXY SESSION');
            console.log(req.session);
            try {
                console.log(req.session.id);
            }
            catch (e) {
                console.log('NO SESSION ID');
            }
            if (!req.session) {
            }
            if (!req.session.data) {
                if (req.protocol) {
                    throw Error('Proxy called without a valid session');
                }
                else {
                    return [2, req.rawHeaders[req.rawHeaders.indexOf('Origin') + 1]];
                }
            }
            if (DEBUG)
                console.log("Proxy called with session data loaded:".concat(util_1.default.inspect(req.session.data)));
            route = routes[req.session.data.activeService].route;
            route = route.replace(/protocol/gi, function (matched) { return req.session.data[matched]; });
            route = route.replace(/tunnel|server/gi, function (matched) {
                return req.session.data[matched] ? req.session.data[matched].port : '';
            });
            if (DEBUG)
                console.log("Proxying request to server ".concat(route));
            return [2, route];
        });
    }); },
    onProxyReqWs: function (proxyReq, req) {
        if (!req.session.data) {
            proxyReq.path = '';
            proxyReq.removeHeader('Upgrade');
            proxyReq.setHeader('Connection', 'close');
        }
    },
};
function errorResponseHandler(err, _req, res) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            if (DEBUG)
                console.log(err);
            res.render('iframe', { iframe_source: ERROR_PATH, sessionID: '' });
            return [2];
        });
    });
}
function startProxy(proxyPort) {
    return __awaiter(this, void 0, void 0, function () {
        var newApp, newServer;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    newApp = (0, express_1.default)();
                    newApp.set('trust proxy', 1);
                    newApp.set('view engine', 'pug');
                    newApp.use((0, express_session_1.default)(sessionParams));
                    newApp.use((0, cookie_parser_1.default)(COOKIE_SECRET));
                    newApp.use(express_1.default.static('html'));
                    newApp.use(initialRequestHandler);
                    newApp.use((0, http_proxy_middleware_1.createProxyMiddleware)(proxyMiddlewareConfig));
                    newApp.use(errorResponseHandler);
                    newServer = newApp.listen(proxyPort, HOST, function () {
                        expressServers.push(newServer);
                    });
                    return [4, (0, wait_port_1.default)({ host: '127.0.0.1', port: proxyPort })];
                case 1:
                    _a.sent();
                    return [2];
            }
        });
    });
}
function cleanupPid() {
    return __awaiter(this, void 0, void 0, function () {
        var sessions_1, error_1;
        var _this = this;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    if (DEBUG)
                        console.log("Cleaning up after termination of PID: ".concat(this.pid));
                    return [4, sessionStoreAll()];
                case 1:
                    sessions_1 = _a.sent();
                    if (DEBUG)
                        console.log("Found open sessions: ".concat(util_1.default.inspect(sessions_1)));
                    Object.keys(sessions_1).forEach(function (sessionID) {
                        var sessionData = sessions_1[sessionID].data;
                        if (sessionData &&
                            ((sessionData.tunnel && sessionData.tunnel.pid == _this.pid) ||
                                (sessionData.server && sessionData.server.pid == _this.pid))) {
                            cleanupSession.bind({ sessionID: sessionID })();
                        }
                    });
                    return [3, 3];
                case 2:
                    error_1 = _a.sent();
                    console.log(error_1);
                    return [3, 3];
                case 3: return [2];
            }
        });
    });
}
function executeCommand(cmd, params, envs, background) {
    return __awaiter(this, void 0, void 0, function () {
        var re, child, result;
        return __generator(this, function (_a) {
            re = new RegExp(Object.keys(params).join('|'), 'g');
            cmd = cmd.replace(re, function (match) { return params[match]; });
            if (DEBUG)
                console.log("Executing command: ".concat(cmd));
            if (background) {
                child = (0, child_process_1.spawn)(cmd.split(' ')[0], cmd.split(' ').slice(1), {
                    env: __assign(__assign({}, process.env), envs),
                });
                if (DEBUG) {
                    child.stdout.on('data', function (data) {
                        console.log("stdout: ".concat(data));
                    });
                    child.stderr.on('data', function (data) {
                        console.log("stderr: ".concat(data));
                    });
                }
                child.on('close', cleanupPid.bind(child));
                return [2, child.pid];
            }
            else {
                result = (0, child_process_1.execSync)(cmd, { env: __assign(__assign({}, process.env), envs) });
                if (DEBUG)
                    console.log(result.toString('utf8'));
            }
            return [2];
        });
    });
}
function cleanupSession() {
    return __awaiter(this, void 0, void 0, function () {
        var sess, sessionData, e_1, e_2, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 13, , 14]);
                    if (DEBUG)
                        console.log("Cleaning up session ID: ".concat(this.sessionID));
                    return [4, sessionStoreGet(this.sessionID)];
                case 1:
                    sess = _a.sent();
                    if (!sess) return [3, 11];
                    sessionData = sess.data;
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    return [4, executeCommand(killCmd, { pid: sessionData.tunnel.pid }, {}, false)];
                case 3:
                    _a.sent();
                    return [3, 5];
                case 4:
                    e_1 = _a.sent();
                    console.log(e_1);
                    return [3, 5];
                case 5:
                    if (!sessionData.server) return [3, 9];
                    _a.label = 6;
                case 6:
                    _a.trys.push([6, 8, , 9]);
                    return [4, executeCommand(killCmd, { pid: sessionData.server.pid }, {}, false)];
                case 7:
                    _a.sent();
                    return [3, 9];
                case 8:
                    e_2 = _a.sent();
                    console.log(e_2);
                    return [3, 9];
                case 9:
                    if (DEBUG)
                        console.log('Destroying session in memory store');
                    return [4, sessionStoreDestroy(this.sessionID)];
                case 10:
                    _a.sent();
                    if (scheduledCleanups[this.sessionID]) {
                        scheduledCleanups[this.sessionID].cancel();
                        delete scheduledCleanups[this.sessionID];
                    }
                    return [3, 12];
                case 11:
                    if (DEBUG)
                        console.log("Session ID: ".concat(this.sessionID, " does not exist"));
                    _a.label = 12;
                case 12: return [3, 14];
                case 13:
                    error_2 = _a.sent();
                    console.log(error_2);
                    return [3, 14];
                case 14: return [2];
            }
        });
    });
}
startProxy(PORT);
//# sourceMappingURL=index.js.map
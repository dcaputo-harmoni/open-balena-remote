// TO DO: replace balena-cli with direct https proxy

const express = require("express");
const URLSearchParams = require("url").URLSearchParams;
const cookieParser = require("cookie-parser");
const { spawn, execSync } = require("child_process");
const { createProxyMiddleware } = require("http-proxy-middleware");
const portfinder = require("portfinder");
const schedule = require("node-schedule");
const session = require("express-session");
const MemoryStore = require("memorystore")(session)
const util = require("util")
const uuid = require("uuid");
const waitPort = require("wait-port");

const DEBUG = false;

// port and host that base instance listens on
const PORT = 10000;
const HOST = "0.0.0.0";
const START_PROXY_PORT = 10001;
const END_PROXY_PORT = 10009;
const COOKIE_SECRET = "bFzjy5TSpypevdWljWspkAqxl8QQSTLG";
const COOKIE_PREFIX = "remote.";
const ERROR_PATH = "/error.html";

const routes = {
  "tunnel": {
    "route": "http://127.0.0.1:tunnel",
  },
  "vnc": {
    "remotePort": 5900,
    "serverCmd": "/usr/local/bin/websockify --web /usr/share/novnc_root localPort 127.0.0.1:tunnelPort",
    "serverPath": "/novnc/vnc.html?autoconnect=true&reconnect=true&reconnect_delay=10",
    "route": "http://127.0.0.1:server",
  },
  "ssh": {
    "remotePort": 22222,
    "serverPath": "/ttyd/?arg=port&arg=uuid&arg=container",
    "route": "http://127.0.0.1:7681",
  },
}

const loginCmd = "/usr/bin/balena login --token apiKey"
const tunnelCmd = "/usr/bin/balena tunnel uuid -p remotePort:127.0.0.1:localPort"
const killCmd = "kill -9 pid"

const sessionStore = new MemoryStore({
  checkPeriod: 24 * 60 * 60 * 1000, // prune expired sessions every 24h (TODO: find a way to have this trigger cleanup just incase)
});
const sessionStoreAll = util.promisify(sessionStore.all.bind(sessionStore));
const sessionStoreSet = util.promisify(sessionStore.set.bind(sessionStore));
const sessionStoreGet = util.promisify(sessionStore.get.bind(sessionStore));
const sessionStoreDestroy = util.promisify(sessionStore.destroy.bind(sessionStore));

const sessionParams = {
  secret: COOKIE_SECRET,
  saveUninitialized: false,
  cookie: {path: "/", httpOnly: true, secure: true, signed: true, maxAge: 6 * 60 * 60 * 1000}, // six hour session max 6 * 60 * 60 * 1000
  resave: false,
  store: sessionStore,
  unset: "destroy",
}

var expressServers = {};
var scheduledCleanups = {};

// On initial call, open VPN tunnel to device, start server if necessary, set session variables and redirect
async function initialRequestHandler (req, res, next) {
  switch (req._parsedUrl.pathname) {
    case "/endSession":
      if (req.query.sessionID && await sessionStoreGet(req.query.sessionID)) {
        if (DEBUG) console.log("Received request to delete session: " + req.query.sessionID);
        cleanupSession.bind({"sessionID": req.query.sessionID})();
        res.sendStatus(200).end(); 
      }
      break;
    default:
      if (routes[req.query.service]) {
        try {
            // create new session in session store
          var sessionID = await startSession();
          // set active service
          var sessionData = { activeService: req.query.service };
          await updateSession(sessionID, sessionData);
          // determine proxy port to use
          sessionData.proxyPort = await getProxyPort(req.signedCookies);
          if (DEBUG) console.log("Setting proxy port to: " + sessionData.proxyPort);
          await updateSession(sessionID, sessionData);
          // log in to openbalena via balena-cli
          await executeCommand(loginCmd, { apiKey: req.query.apiKey }, false);
          // get remote port
          var remotePort = routes[req.query.service].remotePort ? routes[req.query.service].remotePort : req.query.port;
          if (!remotePort) { throw "Port must be provided to tunnel" }
          // open vpn tunnel via balena-cli
          sessionData.tunnel = { port: await portfinder.getPortPromise({ port: 20000, stopPort: 29999 }) };
          sessionData.tunnel.pid = await executeCommand(tunnelCmd, {
            uuid: req.query.uuid, 
            remotePort: remotePort,
            localPort: sessionData.tunnel.port
            }, true);
          await updateSession(sessionID, sessionData);
          var portOpen = await waitPort({ host: "127.0.0.1", port: sessionData.tunnel.port, timeout: 10 * 1000 });
          if (!portOpen) { throw "Unable to open VPN tunnel" };
          if (DEBUG) console.log("Opened VPN tunnel from 127.0.0.1:" + sessionData.tunnel.port + " to remote device " + req.query.uuid + ":" + remotePort + " with PID " + sessionData.tunnel.pid);
          var redirect = req.protocol + "://" + req.headers.host.split(":")[0] + ":" + sessionData.proxyPort;
          // if necessary to start custom server to faciltate request, do so
          if (routes[req.query.service].serverCmd) {
            sessionData.server = { port: await portfinder.getPortPromise({ port: 30000, stopPort: 39999 }) };
            sessionData.server.pid = await executeCommand(routes[req.query.service].serverCmd, {
              localPort: sessionData.server.port,
              remotePort: remotePort,
              tunnelPort: sessionData.tunnel.port
            }, true);
            await updateSession(sessionID, sessionData);
            portOpen = await waitPort({host: "127.0.0.1", port: sessionData.server.port, timeout: 10 * 1000});
            if (!portOpen) { throw "Unable to start server" };
            if (DEBUG) console.log(sessionData.server.port == "" ? "No server was started as this is a proxy request only" : "Started server at 127.0.0.1:" + sessionData.server.port + " with PID " + sessionData.server.pid);
          }
          // if routing via server instead of directly to target, generate route path using serverPath
          if (routes[req.query.service].serverPath) {
            redirect += routes[req.query.service].serverPath.replace(/port|uuid|container/gi, function(matched){
              // replace port with server port first (if specified), then tunnel port if no server
              return req.query[matched] || (sessionData.server ? sessionData.server[matched] : sessionData.tunnel[matched]) || "";
            });
          // otherwise just pass on path based on url provided with initial request to remote
          } else {
            ["service", "apiKey", "uuid", "container", "port"].forEach(item => delete req.query[item]);
            redirect += req._parsedUrl.pathname + "?" + (new URLSearchParams(req.query)).toString();
          }
          var cookieParams = sessionParams.cookie;
          // override cookie / session expiry if ttlSecs provided
          if (req.query.ttlSecs) {
            cookieParams.maxAge = parseInt(req.query.ttlSecs) * 1000;
          }
          // set cookie with new session ID
          res.cookie(COOKIE_PREFIX + sessionData.proxyPort, sessionID, cookieParams);
          // schedule cleanup of session
          var scheduledCleanupDate = new Date((new Date()).getTime() + cookieParams.maxAge).toISOString();
          if (DEBUG) console.log("Scheduling session cleanup for: " + scheduledCleanupDate);
          scheduledCleanups[sessionID] = schedule.scheduleJob(scheduledCleanupDate, cleanupSession.bind({"sessionID": sessionID}));
          // finally, redirect!
          if (DEBUG) console.log("Redirecting to path: " + redirect);
          res.render("iframe", { iframe_source: redirect, sessionID: sessionID });
        } catch (err) {
          // pass error to error response handler downstream
          next(err);
        }
      } else {
        next();
      }
  }
}

const proxyMiddlewareConfig = {
  target: "",
  changeOrigin: true,
  secure: false,
  ws: true,
  router: async (req) => {
    if (DEBUG) console.log("Received proxy request at " + ( req.protocol ? req.protocol : "ws" ) + "://" + req.rawHeaders[(req.rawHeaders.indexOf("host") !== -1 ? req.rawHeaders.indexOf("host") : req.rawHeaders.indexOf("Host")) + 1] + req.url);
    // if no session tied to request (websocket), get session data from memorystore using http headers
    if (!req.session) {
      req.session = { data: await getSessionData(req.rawHeaders) };
    }
    if (!req.session.data) {
      if (req.protocol) {
        throw "Proxy called without a valid session";
      } else {
        // if websocket request with invalid session, handle downstream
        return req.rawHeaders[req.rawHeaders.indexOf("Origin") + 1];
      }
    }
    if (DEBUG) console.log("Proxy called with session data loaded:" + util.inspect(req.session.data));
    // include tunnel or server port as needed
    var route = routes[req.session.data.activeService].route.replace(/tunnel|server/gi, (matched) => {
      return req.session.data[matched] ? req.session.data[matched].port : "";
    });
    // finally, route!
    if (DEBUG) console.log("Proxying request to server " + route);
    return route;
  },
  onProxyReqWs: (proxyReq, req, socket, options, head) => {
    if (!req.session.data) {
      // downgrade to HTTP request to be subsequently killed
      proxyReq.path = "";
      proxyReq.removeHeader("Upgrade");
      proxyReq.setHeader("Connection", "close");
    }
  }
};

async function errorResponseHandler (err, req, res, next) {
  if (DEBUG) console.log(err);
  res.render("iframe", { iframe_source: ERROR_PATH, sessionID: "" });
}

// Helper function to execute command and return port and PID (returned from shell script)
async function executeCommand(cmd, params, background) {
  // replace variables in command using keys from params
  var re = new RegExp(Object.keys(params).join('|'), 'g');
  cmd = cmd.replace(re, match => params[match]);
  if (DEBUG) console.log("Executing command: " + cmd);
  // if executing in background, run as spawn to return child process with pid
  if (background) {
    var child = spawn(cmd.split(" ")[0], cmd.split(" ").slice(1));
    if (DEBUG) {
      child.stdout.on('data', (data) => { console.log('stdout: ' + data) });
      child.stderr.on('data', (data) => { console.log('stderr: ' + data) });
    }
    child.on("close", cleanupPid.bind(child));
    return child.pid;
  // if executing in foreground, run as execSync
  } else {
    var result = execSync(cmd);
    if (DEBUG) console.log(result.toString("utf8"));
  }
}

// Helper function to get session data from request headers (needed for websocket connections)
async function getSessionData(reqHeaders) {
  var cookies = {};
  var cookieHeaderIdx = reqHeaders.indexOf("cookie") !== -1 ? reqHeaders.indexOf("cookie") : reqHeaders.indexOf("Cookie");
  decodeURIComponent(reqHeaders[cookieHeaderIdx + 1]).split(';').forEach(function(cookie) {
    var parts = cookie.match(/(.*?)=(.*)$/)
    if (parts) { cookies[ parts[1].trim() ] = (parts[2] || '').trim() };
  });
  // parse port from headers
  var hostHeaderIdx = reqHeaders.indexOf("host") !== -1 ? reqHeaders.indexOf("host") : reqHeaders.indexOf("Host");
  var host = reqHeaders[hostHeaderIdx + 1];
  var port = host.includes(":") ? host.split(":")[1] : PORT;
  // decrypt cookie being used by current server into session ID
  var sessionID = cookieParser.signedCookie(cookies[COOKIE_PREFIX + port], sessionParams.secret);
  // load session data from memory store
  if (DEBUG) console.log("Decoding memory store from websocket request with SID " + sessionID);
  var session = await sessionStoreGet(sessionID);
  if (session) {
    return session.data;
  } else {
    return null;
  }
}

// Helper function to get next proxy port
async function getProxyPort(cookies) {
  var cookiesArr = [];
  // get port # and expiry date for each currently used cookie (session)
  for (cookieName of Object.keys(cookies)) {
    var port = cookieName.split(".")[1];
    var session = await sessionStoreGet(cookies[cookieName]);
    if (session) {
      cookiesArr.push({ sessionID: cookies[cookieName], port: parseInt(port), expires: new Date(session.cookie.expires) });
    }
  }
  if (DEBUG) console.log("Finding next available port using detected active sessions: " + util.inspect(cookiesArr));
  // always use base port if available, otherwise remove it from the list
  if (!cookiesArr.find(x => x.port == PORT)) {
    return PORT;
  } else {
    cookiesArr = cookiesArr.filter(x => x.port != PORT);
  }
  // otherwise find lowest open port in range
  for (var i = START_PROXY_PORT; i <= END_PROXY_PORT; i++) {
    if (!cookiesArr.find(x => x.port == i)) {
      return i;
    }
  }
  // otherwise find the soonest expiring port, kill old session and reuse it
  cookiesArr.sort((a, b) => a.expires - b.expires);
  cleanupSession.bind({"sessionID": cookiesArr[0].sessionID})();
  return cookiesArr[0].port;
}

// Helper function to manually start a session and save it in memorystore
async function startSession() {
  // generate sessionID
  var sessionID = uuid.v1();
  var newCookie = JSON.parse(JSON.stringify(sessionParams.cookie));
  // populate originalMaxAge and expires which are needed by memorystore, remove maxAge
  newCookie.originalMaxAge = newCookie.maxAge;
  newCookie.expires = new Date((new Date()).getTime() + sessionParams.cookie.maxAge).toISOString();
  delete newCookie.maxAge;
  // save session in memorystore
  await sessionStoreSet(sessionID, { cookie: newCookie, data: {} });
  return sessionID;
}

// Helper function to update a session in memorystore
async function updateSession(sessionID, sessionData) {
  var session = await sessionStoreGet(sessionID);
  session.data = sessionData;
  await sessionStoreSet(sessionID, session);
}

// Helper function to start a new express / proxy server
async function startProxy(proxyPort, initialHandler) {
  var newApp = express();
  var proxySessionParams = sessionParams;
  // set appropriate prefix for session cookie based on port
  proxySessionParams.name = COOKIE_PREFIX + proxyPort;
  newApp.set("trust proxy", 1);
  newApp.set("view engine", "pug");
  newApp.use(session(proxySessionParams));
  newApp.use(cookieParser(COOKIE_SECRET));
  newApp.use(express.static("html"));
  // only include initial request handler in base instance
  if (initialHandler === true) {
    newApp.use(initialRequestHandler);
  }
  newApp.use(createProxyMiddleware(proxyMiddlewareConfig));
  newApp.use(errorResponseHandler);

  var newServer = newApp.listen(proxyPort, HOST, () => {
    // add server to global object to allow subsequent access
    expressServers[newServer.address().port] = newServer;
  });
  // wait for proxy server to come online
  await waitPort({host: "127.0.0.1", port: proxyPort});
}

// Helper function to cleanup when PID is terminated
async function cleanupPid() {
  try {
    if (DEBUG) console.log("Cleaning up after termination of PID: " + this.pid);
    var sessions = await sessionStoreAll();
    if (DEBUG) console.log("Found open sessions: " + util.inspect(sessions));
    Object.keys(sessions).forEach(sessionID => {
      var sessionData = sessions[sessionID].data;
      if (sessionData && ((sessionData.tunnel && sessionData.tunnel.pid == this.pid) || (sessionData.server && sessionData.server.pid == this.pid))) {
        cleanupSession.bind({"sessionID": sessionID})();
      }
    })
} catch (error) {
    console.log(error);
  }
}

// Helper function to cleanup when session is terminated
async function cleanupSession() {
  try {
    if (DEBUG) console.log("Cleaning up session ID: " + this.sessionID);
    var session = await sessionStoreGet(this.sessionID);
    if (session) {
      var sessionData = session.data;
      // kill tunnel and server processes; ignore errors on killing (aready killed)
      try { await executeCommand(killCmd, {pid: sessionData.tunnel.pid}, false); } catch {};
      if (sessionData.server) {
        try { await executeCommand(killCmd, {pid: sessionData.server.pid}, false); } catch {};
      }
      // remove session data from memory store
      if (DEBUG) console.log("Destroying session in memory store");
      await sessionStoreDestroy(this.sessionID);
      // cancel and remove shceduled cleanup object because it is complete
      if (scheduledCleanups[this.sessionID]) {
        scheduledCleanups[this.sessionID].cancel();
        delete scheduledCleanups[this.sessionID];
      }
    } else {
      if (DEBUG) console.log("Session ID: " + this.sessionID + " does not exist");
    }
  } catch (error) {
    console.log(error);
  }
}

startProxy(PORT, true);
var i = START_PROXY_PORT;
while (i <= END_PROXY_PORT) { startProxy(i++, false); };
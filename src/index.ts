/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable indent */
// TO DO: replace balena-cli with direct https proxy

import { URLSearchParams } from 'url';
import express from 'express';
//import cookieParser from 'cookie-parser';
import { spawn, execSync } from 'child_process';
import { createProxyMiddleware } from 'http-proxy-middleware';
import portfinder from 'portfinder';
//import schedule from 'node-schedule';
import expressSession from 'express-session';
import createMemoryStore from 'memorystore';
import util from 'util';
import waitPort from 'wait-port';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();
import cors from 'cors';

const DEBUG = true;

// port and host that base instance listens on
const PORT = 80;
const HOST = '0.0.0.0';
const COOKIE_SECRET = 'bFzjy5TSpypevdWljWspkAqxl8QQSTLG';
const ERROR_PATH = '/error.html';

const routes: any = {
  tunnel: {
    route: 'protocol://127.0.0.1:tunnel',
  },
  vnc: {
    remotePort: 5900,
    serverCmd:
      '/usr/local/bin/websockify --web /usr/share/novnc_root localPort 127.0.0.1:tunnelPort',
    serverPath:
      '/novnc/vnc.html?autoconnect=true&reconnect=true&reconnect_delay=10',
    route: 'http://127.0.0.1:server',
  },
  ssh: {
    remotePort: 22222,
    serverPath:
      '/ttyd/?arg=port&arg=uuid&arg=container&arg=username&arg=sessionDir',
    route: 'http://127.0.0.1:7681',
  },
};

const loginCmd = '/usr/bin/balena login --token apiKey';
const tunnelCmd =
  '/usr/bin/balena tunnel uuid -p remotePort:127.0.0.1:localPort';
const killCmd = 'kill -9 pid';

const store = createMemoryStore(expressSession);
const sessionStore = new store({
  checkPeriod: 24 * 60 * 60 * 1000, // prune expired sessions every 24h (TODO: find a way to have this trigger cleanup just incase)
});
const sessionStoreAll = util.promisify(sessionStore.all.bind(sessionStore));
//const sessionStoreSet = util.promisify(sessionStore.set.bind(sessionStore));
const sessionStoreGet = util.promisify(sessionStore.get.bind(sessionStore));
const sessionStoreDestroy = util.promisify(
  sessionStore.destroy.bind(sessionStore)
);

const sessionParams: expressSession.SessionOptions = {
  secret: COOKIE_SECRET,
  cookie: {
    secure: false,
    sameSite: 'lax',
    maxAge: 6 * 60 * 60 * 1000,
  }, // six hour session max 6 * 60 * 60 * 1000
  store: sessionStore,
  resave: false,
  saveUninitialized: true,
};

const expressServers: any = {};
const scheduledCleanups: any = {};

// On initial call, open VPN tunnel to device, start server if necessary, set session variables and render iframe
async function initialRequestHandler(req: any, res: any, next: any) {
  const {
    session,
  }: { session: expressSession.Session & Partial<{ data: any }> } = req;
  console.log('INITIAL HANDLER SESSION');
  console.log(session.id);
  switch (req._parsedUrl.pathname) {
    case '/endSession': {
      const { sessionID } = req.query;
      if (sessionID && (await sessionStoreGet(sessionID))) {
        if (DEBUG)
          console.log(`Received request to delete session: ${sessionID}`);
        cleanupSession.bind({ sessionID: sessionID })();
        res.sendStatus(200).end();
      }
      break;
    }
    default: {
      // TODO: move service, port, jwt, apiKey, privateKey, protocol and ttlSecs query params to a header
      // to avoid confilict with app and from having to delete them later
      const {
        service,
        port,
        uuid,
        jwt,
        apiKey,
        privateKey,
        protocol,
        ttlSecs,
      } = req.query;
      if (service && routes[service]) {
        try {
          // create new session
          await util.promisify(session.regenerate.bind(session))();
          session.data = {};
          session.save((e: Error) => (e ? console.log(e) : void 0));
          session.data.activeService = service;
          // create unique session directory to hold balena token for this session
          session.data.sessionDir = `/tmp/${session.id}`;
          if (!fs.existsSync(session.data.sessionDir)) {
            fs.mkdirSync(session.data.sessionDir);
          }
          if (!jwt && !apiKey) {
            throw Error('At least one of jwt or apiKey must be specified');
          }
          if (jwt) {
            // save provided JWT to session folder
            fs.writeFileSync(`${session.data.sessionDir}/token`, jwt);
          } else {
            // otherwise log in to openbalena using apiKey to get jwt
            await executeCommand(
              loginCmd,
              {
                apiKey: apiKey,
              },
              { BALENARC_DATA_DIRECTORY: session.data.sessionDir },
              false
            );
          }
          // get remote port
          const remotePort = routes[service].remotePort
            ? routes[service].remotePort
            : port;
          if (!remotePort) {
            throw Error('Port must be provided to tunnel');
          }
          // open vpn tunnel via balena-cli
          session.data.tunnel = {
            port: await portfinder.getPortPromise({
              port: 20000,
              stopPort: 29999,
            }),
          };
          session.data.tunnel.pid = await executeCommand(
            tunnelCmd,
            {
              uuid,
              remotePort: remotePort,
              localPort: session.data.tunnel.port,
              tunnelID: session.data.tunnel.id,
            },
            { BALENARC_DATA_DIRECTORY: session.data.sessionDir },
            true
          );
          let portOpen = await waitPort({
            host: '127.0.0.1',
            port: session.data.tunnel.port,
            timeout: 10 * 1000,
          });
          if (!portOpen) {
            throw Error('Unable to open VPN tunnel');
          }
          if (DEBUG)
            console.log(
              `Opened VPN tunnel from 127.0.0.1:${session.data.tunnel.port} to remote device ${uuid}:${remotePort} with PID ${session.data.tunnel.pid}`
            );
          let redirectPath = `${req.protocol}://${req.headers.host}`;
          // if necessary to start custom server to faciltate request, do so
          if (routes[service].serverCmd) {
            session.data.server = {
              port: await portfinder.getPortPromise({
                port: 30000,
                stopPort: 39999,
              }),
            };
            session.data.server.pid = await executeCommand(
              routes[service].serverCmd,
              {
                localPort: session.data.server.port,
                remotePort: remotePort,
                tunnelPort: session.data.tunnel.port,
              },
              {},
              true
            );
            portOpen = await waitPort({
              host: '127.0.0.1',
              port: session.data.server.port,
              timeout: 10 * 1000,
            });
            if (!portOpen) {
              throw Error('Unable to start server');
            }
            if (DEBUG)
              console.log(
                session.data.server.port == ''
                  ? 'No server was started as this is a proxy request only'
                  : `Started server at 127.0.0.1:${session.data.server.port} with PID ${session.data.server.pid}`
              );
          }
          // if routing via server instead of directly to target, generate route path using serverPath
          if (routes[service].serverPath) {
            redirectPath += routes[service].serverPath.replace(
              /port|uuid|container|username|sessionDir/gi,
              function (matched: string) {
                // replace port with server port first (if specified), then tunnel port if no server
                return (
                  (req.query[matched]
                    ? encodeURIComponent(req.query[matched])
                    : session.data.server
                    ? session.data.server[matched]
                    : session.data.tunnel[matched]) ||
                  session.data[matched] ||
                  ''
                );
              }
            );
            // save private key to session directory if provided
            if (privateKey) {
              fs.writeFileSync(
                `${session.data.sessionDir}/privateKey`,
                privateKey
              );
              fs.chmodSync(`${session.data.sessionDir}/privateKey`, '0600');
            }
            // otherwise just pass on path based on url provided with initial request to remote
          } else {
            // save protocol (if provided) in session
            if (protocol) {
              session.data.protocol = protocol;
            }
            // remove special query params from iframe path
            // TODO: move these to headers to avoid conflicts and having to remove
            [
              'service',
              'apiKey',
              'uuid',
              'container',
              'port',
              'protocol',
            ].forEach((item) => delete req.query[item]);
            redirectPath += `${req._parsedUrl.pathname}?${new URLSearchParams(
              req.query
            ).toString()}`;
          }
          const cookieParams = sessionParams.cookie;
          // override cookie / session expiry if ttlSecs provided
          if (ttlSecs) {
            cookieParams!.maxAge = parseInt(ttlSecs) * 1000;
          }
          /*
          // schedule cleanup of session
          const scheduledCleanupDate = new Date(
            new Date().getTime() + cookieParams.maxAge
          ).toISOString();
          if (DEBUG) console.log("Scheduling session cleanup for: " + scheduledCleanupDate);
          scheduledCleanups[sessionID] = schedule.scheduleJob(scheduledCleanupDate, cleanupSession.bind({"sessionID": sessionID}));
          */
          // finally, render iframe!
          console.log('FINAL SESSION');
          console.log(session);
          try {
            console.log(session.id);
          } catch (e) {
            console.log('NO SESSION ID');
          }
          req.session.save(() => res.redirect(redirectPath));
        } catch (err) {
          // pass error to error response handler downstream
          next(err);
        }
      } else {
        next();
      }
    }
  }
}

const proxyMiddlewareConfig = {
  target: '',
  changeOrigin: true,
  secure: false,
  ws: true,
  router: async (req: any) => {
    const {
      session,
    }: { session: expressSession.Session & Partial<{ data: any }> } = req;

    if (DEBUG)
      console.log(
        `Received proxy request at ${req.protocol ? req.protocol : 'ws'}://${
          req.rawHeaders[
            (req.rawHeaders.indexOf('host') !== -1
              ? req.rawHeaders.indexOf('host')
              : req.rawHeaders.indexOf('Host')) + 1
          ]
        }${req.url}`
      );
    // if no session tied to request (websocket), get session data from memorystore using http headers
    console.log('PROXY SESSION');
    console.log(session);
    console.log('STORE DATA');
    console.log(await sessionStoreGet(session.id));
    try {
      console.log(session.id);
    } catch (e) {
      console.log('NO SESSION ID');
    }
    if (!session) {
      //session = { data: await getSessionData(req.rawHeaders) };
    }
    if (!session.data) {
      if (req.protocol) {
        throw Error('Proxy called without a valid session');
      } else {
        // if websocket request with invalid session, handle downstream
        return req.rawHeaders[req.rawHeaders.indexOf('Origin') + 1];
      }
    }
    if (DEBUG)
      console.log(
        `Proxy called with session data loaded:${util.inspect(session.data)}`
      );
    let route = routes[session.data.service].route;
    // include protocol as needed
    route = route.replace(
      /protocol/gi,
      (matched: string) => session.data[matched]
    );
    // include tunnel or server port as needed
    route = route.replace(/tunnel|server/gi, (matched: string) =>
      session.data[matched] ? session.data[matched].port : ''
    );
    // finally, route!
    if (DEBUG) console.log(`Proxying request to server ${route}`);
    return route;
  },
  onProxyReqWs: (proxyReq: any, req: any) => {
    const {
      session,
    }: { session: expressSession.Session & Partial<{ data: any }> } = req;

    if (!session.data) {
      // downgrade to HTTP request to be subsequently killed
      proxyReq.path = '';
      proxyReq.removeHeader('Upgrade');
      proxyReq.setHeader('Connection', 'close');
    }
  },
};

async function errorResponseHandler(err: Error, _req: any, res: any) {
  if (DEBUG) console.log(err);
  res.render('iframe', { iframe_source: ERROR_PATH, sessionID: '' });
}

// Helper function to start a new express / proxy server
async function startProxy(proxyPort: number) {
  const newApp = express();
  newApp.set('trust proxy', 1);
  newApp.set('view engine', 'pug');
  newApp.use(
    cors({
      credentials: true,
      origin: ['http://localhost', 'http://localhost:80'],
    })
  );
  newApp.use(expressSession(sessionParams));
  //newApp.use(cookieParser(COOKIE_SECRET));
  newApp.use(express.static('html'));
  newApp.use(initialRequestHandler);
  newApp.use(createProxyMiddleware(proxyMiddlewareConfig));
  newApp.use(errorResponseHandler);

  const newServer = newApp.listen(proxyPort, HOST, () => {
    // add server to global object to allow subsequent access
    expressServers[proxyPort] = newServer;
  });
  // wait for proxy server to come online
  await waitPort({ host: '127.0.0.1', port: proxyPort });
}

// Helper function to cleanup when PID is terminated
async function cleanupPid() {
  try {
    if (DEBUG) console.log(`Cleaning up after termination of PID: ${this.pid}`);
    const sessions = await sessionStoreAll();
    if (DEBUG) console.log(`Found open sessions: ${util.inspect(sessions)}`);
    Object.keys(sessions).forEach((sessionID) => {
      const sessionData = sessions[sessionID].data;
      if (
        sessionData &&
        ((sessionData.tunnel && sessionData.tunnel.pid == this.pid) ||
          (sessionData.server && sessionData.server.pid == this.pid))
      ) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        cleanupSession.bind({ sessionID: sessionID })();
      }
    });
  } catch (error) {
    console.log(error);
  }
}

// Helper function to execute command and return port and PID (returned from shell script)
async function executeCommand(
  cmd: string,
  params: any,
  envs: any,
  background: any
) {
  // replace variables in command using keys from params
  const re = new RegExp(Object.keys(params).join('|'), 'g');
  cmd = cmd.replace(re, (match) => params[match]);
  if (DEBUG) console.log(`Executing command: ${cmd}`);
  // if executing in background, run as spawn to return child process with pid
  if (background) {
    const child = spawn(cmd.split(' ')[0], cmd.split(' ').slice(1), {
      env: { ...process.env, ...envs },
    });
    if (DEBUG) {
      child.stdout.on('data', (data: string) => {
        console.log(`stdout: ${data}`);
      });
      child.stderr.on('data', (data: string) => {
        console.log(`stderr: ${data}`);
      });
    }
    child.on('close', cleanupPid.bind(child));
    return child.pid;
    // if executing in foreground, run as execSync
  } else {
    const result = execSync(cmd, { env: { ...process.env, ...envs } });
    if (DEBUG) console.log(result.toString('utf8'));
  }
}

// Helper function to cleanup when session is terminated
async function cleanupSession() {
  try {
    if (DEBUG) console.log(`Cleaning up session ID: ${this.sessionID}`);
    const sess = await sessionStoreGet(this.sessionID);
    if (sess) {
      const sessionData = sess.data;
      // kill tunnel and server processes; ignore errors on killing (aready killed)
      try {
        await executeCommand(
          killCmd,
          { pid: sessionData.tunnel.pid },
          {},
          false
        );
      } catch (e) {
        console.log(e);
      }
      if (sessionData.server) {
        try {
          await executeCommand(
            killCmd,
            { pid: sessionData.server.pid },
            {},
            false
          );
        } catch (e) {
          console.log(e);
        }
      }
      // remove session folder
      //fs.rmSync(sessionData.sessionDir, { recursive: true, force: true });
      // remove session data from memory store
      if (DEBUG) console.log('Destroying session in memory store');
      await sessionStoreDestroy(this.sessionID);
      // cancel and remove shceduled cleanup object because it is complete
      if (scheduledCleanups[this.sessionID]) {
        scheduledCleanups[this.sessionID].cancel();
        delete scheduledCleanups[this.sessionID];
      }
    } else {
      if (DEBUG) console.log(`Session ID: ${this.sessionID} does not exist`);
    }
  } catch (error) {
    console.log(error);
  }
}
startProxy(PORT);

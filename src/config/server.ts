// Listen only on this machine unless HOST says otherwise. Containers must set
// HOST=0.0.0.0 so published ports can reach the server.
export const SERVER_HOST = process.env.HOST || "127.0.0.1";

const requestedPort = Number.parseInt(process.env.PORT || "", 10);
export const SERVER_PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536
  ? requestedPort
  : 3333;

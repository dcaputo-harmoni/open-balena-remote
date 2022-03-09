# open-balena-remote

To use open-balena-remote:

Initiate GET request to open-balena-remote server (port can be changed via PORT variable)
Provide the required query parameters in the URL string:
service - "ssh", "vnc", or a container such as "app-node-red"
If service is a container (i.e. "app-node-red"), optionally append the initial URL path to access in that container (i.e. /app-node-red/nr-admin)
container - currently only applicable to "ssh" service, specifies which device container to ssh into.  Ignored for all other services.
uuid - device UUID to access (short form is acceptable)
apiKey - openbalena API key with permission to access requested device UUID

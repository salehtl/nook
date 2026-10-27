# fal-client (PyPI), the fal.ai Python client nook-add uses for live calls. It isn't in nixpkgs, so it's packaged here
# from its pure-Python wheel; every dependency is in nixpkgs. Keep the version in step with pipeline/uv.lock.
{
  lib,
  buildPythonPackage,
  fetchPypi,
  aiofiles,
  asyncstdlib,
  httpx,
  httpx-sse,
  msgpack,
  websockets,
}:
buildPythonPackage rec {
  pname = "fal-client";
  version = "1.0.3";
  format = "wheel";

  src = fetchPypi {
    pname = "fal_client";
    inherit version;
    format = "wheel";
    dist = "py3";
    python = "py3";
    hash = "sha256-uY+X2Q1DTFz3o5r9Wsgqcy5+x1DxY6YTyEL7UFLGU+0=";
  };

  dependencies = [
    aiofiles
    asyncstdlib
    httpx
    httpx-sse
    msgpack
    websockets
  ];

  pythonImportsCheck = [ "fal_client" ];

  meta = {
    description = "Python client for fal.ai";
    homepage = "https://github.com/fal-ai/fal";
    license = lib.licenses.asl20;
  };
}

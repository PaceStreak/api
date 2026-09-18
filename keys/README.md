RS256 keypair for signing access tokens.

Generate with `make keys` (wraps openssl). Never commit the .pem files - they
are git-ignored - and mount the private key from a secret store in production,
not bake it into the image.

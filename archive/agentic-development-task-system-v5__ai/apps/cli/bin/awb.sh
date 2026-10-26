#!/usr/bin/env sh
SELF=$0
while [ -h "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case $LINK in
    /*) SELF=$LINK ;;
    *) SELF=$(dirname -- "$SELF")/$LINK ;;
  esac
done
DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd -P)
exec "$DIR/../node_modules/.bin/tsx" "$DIR/../src/index.ts" "$@"

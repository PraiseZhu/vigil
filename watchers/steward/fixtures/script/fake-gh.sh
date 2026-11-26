#!/bin/sh
case "$1:$2" in
  api:--hostname)
    test "$3:$4" = github.com:user || exit 64
    test -n "$FIXTURE_GH_LOGIN" || exit 1
    printf '%s\n' "$FIXTURE_GH_LOGIN"
    ;;
  api:repos/example-org/example-repo/pulls\?state=open\&per_page=100)
    printf '[[]]\n'
    ;;
  *) exit 64 ;;
esac

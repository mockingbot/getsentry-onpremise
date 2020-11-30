#!/usr/bin/env bash

SCRIPT_PATH="$(dirname "$(realpath "${BASH_SOURCE[0]}")")" # Absolute directory path this script is in

dr-js --eval --input-file "${SCRIPT_PATH}/trysen.js"

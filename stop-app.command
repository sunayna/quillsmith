#!/bin/bash
# Double-click entry point: stops the local web UI started by
# start-app.command. Finds whatever's listening on the app's port and
# kills it. Safe to run even if nothing's running — it just says so and
# does nothing.

PORT="${PORT:-4173}"
PIDS=$(lsof -ti tcp:"$PORT")

if [ -z "$PIDS" ]; then
  echo "Nothing is running on port $PORT — already stopped."
else
  echo "Stopping process(es) on port $PORT: $PIDS"
  kill $PIDS
  sleep 1
  # Force-kill anything that ignored the polite signal
  STILL=$(lsof -ti tcp:"$PORT")
  if [ -n "$STILL" ]; then
    kill -9 $STILL
  fi
  echo "Stopped."
fi

echo ""
read -p "Press Enter to close this window..."

#!/bin/bash
cd /opt/crm-api && node sheets-refresh.cjs 2>/dev/null
if [ $? -eq 0 ]; then
  cp /opt/crm-api/sheets-token.env /root/sheets-token.env
  echo "[$(date)] Token refreshed and copied to /root/" >> /var/log/sheets-refresh.log
fi

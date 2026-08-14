import 'dotenv/config';
import net from 'node:net';

const port = Number(process.env.TCP_PORT || 5000);
const apiUrl = process.env.API_URL || 'http://localhost:10000';
const secret = process.env.INGEST_SECRET;

// Store the latest status received from each tracker.
// IMPORTANT:
// GT06 0x13 heartbeat contains the reliable ACC status.
const deviceStatus = new Map();

/* =========================================================
   BCD / IMEI
========================================================= */

function bcd(buffer) {
  return [...buffer]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
    .replace(/^0/, '')
    .replace(/F/g, '');
}

/* =========================================================
   CRC16
========================================================= */

function crc16(buffer) {
  let crc = 0xffff;

  for (const byte of buffer) {
    crc ^= byte << 8;

    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }

  return crc;
}

/* =========================================================
   ACK
========================================================= */

function ack(protocol, serial) {
  const payload = Buffer.from([
    0x05,
    protocol,
    (serial >> 8) & 0xff,
    serial & 0xff,
  ]);

  const crc = crc16(payload);

  return Buffer.concat([
    Buffer.from([0x78, 0x78]),
    payload,
    Buffer.from([
      (crc >> 8) & 0xff,
      crc & 0xff,
      0x0d,
      0x0a,
    ]),
  ]);
}

/* =========================================================
   GPS PARSER - PROTOCOL 0x12
========================================================= */

function parseGps(frame, imei) {
  /*
    GT06 frame:

    78 78
    LENGTH
    PROTOCOL
    DATA...
    SERIAL
    CRC
    0D 0A

    For GPS 0x12:

    p[0]       protocol
    p[1..6]    date/time
    p[7]       satellites
    p[8..11]   latitude
    p[12..15]  longitude
    p[16]      speed
    p[17..18]  course/status
  */

  const p = frame.subarray(3, frame.length - 6);

  if (p.length < 19 || p[0] !== 0x12) {
    return null;
  }

  /* -------------------------
     Date / Time
  ------------------------- */

  const date = p.subarray(1, 7);

  const year = 2000 + date[0];
  const month = date[1];
  const day = date[2];
  const hour = date[3];
  const minute = date[4];
  const second = date[5];

  const timestamp = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second
    )
  );

  /* -------------------------
     Satellites
  ------------------------- */

  const satellites = p[7] & 0x0f;

  /* -------------------------
     Latitude / Longitude
  ------------------------- */

  const rawLat = p.readUInt32BE(8);
  const rawLng = p.readUInt32BE(12);

  const latitude = rawLat / 30000 / 60;
  const longitude = rawLng / 30000 / 60;

  /* -------------------------
     Course / Direction
  ------------------------- */

  const courseStatus = p.readUInt16BE(17);

  /*
    GT06:

    bit 11 = West
    bit 10 = North
  */

  const isWest = (courseStatus & 0x0800) !== 0;
  const isNorth = (courseStatus & 0x0400) !== 0;

  const finalLat = isNorth
    ? latitude
    : -latitude;

  const finalLng = isWest
    ? -longitude
    : longitude;

  /* -------------------------
     Raw GPS speed
  ------------------------- */

  const gpsSpeed = p[16];

  /* -------------------------
     GET LAST 0x13 STATUS
  ------------------------- */

  const status = deviceStatus.get(imei);

  /*
    DO NOT guess ignition.

    If we have received a heartbeat,
    use its ACC state.

    If we haven't received one yet,
    ignition remains unknown.
  */

  const ignition =
    status?.ignition ?? null;

  /*
    IMPORTANT:

    If ACC is OFF:
       speed MUST be 0.

    If ACC is ON:
       use actual GPS speed.

    If ACC is unknown:
       use GPS speed temporarily.
  */

  let finalSpeed;

  if (ignition === false) {
    finalSpeed = 0;
  } else {
    finalSpeed = gpsSpeed;
  }

  const point = {
    imei: imei || 'unknown',

    lat: finalLat,
    lng: finalLng,

    speed: finalSpeed,

    course: courseStatus & 0x03ff,

    ignition,

    satellites,

    timestamp,

    /*
      Debug information
    */

    rawLat,
    rawLng,

    gpsSpeed,

    courseStatus:
      `0x${courseStatus
        .toString(16)
        .padStart(4, '0')}`,

    north: isNorth,
    west: isWest,

    /*
      Status information
    */

    statusKnown: ignition !== null,

    terminalInfo:
      status?.terminalInfo ?? null,
  };

  console.log('');
  console.log('========================================');
  console.log('PARSED GPS');
  console.log('========================================');

  console.log('IMEI:', point.imei);
  console.log('Latitude:', point.lat);
  console.log('Longitude:', point.lng);

  console.log('GPS Speed:', gpsSpeed);
  console.log('Final Speed:', finalSpeed);

  console.log(
    'Ignition:',
    ignition === true
      ? 'ON'
      : ignition === false
        ? 'OFF'
        : 'UNKNOWN'
  );

  console.log('Satellites:', satellites);
  console.log('Course:', point.course);

  console.log(
    'Terminal Info:',
    status?.terminalInfo !== undefined
      ? `0x${status.terminalInfo
          .toString(16)
          .padStart(2, '0')}`
      : 'UNKNOWN'
  );

  console.log('========================================');
  console.log('');

  return point;
}

/* =========================================================
   STATUS / HEARTBEAT PARSER - PROTOCOL 0x13
========================================================= */

function parseStatus(frame, imei) {
  /*
    Example received from your tracker:

    78 78
    0A
    13
    45
    06
    03
    00 01
    00 1C
    36 DD
    0D 0A

    Fields:

    frame[4] = Terminal Information
    frame[5] = Voltage
    frame[6] = GSM signal
    frame[7..8] = Alarm / language
    frame[9..10] = serial
  */

  if (frame.length < 15) {
    return null;
  }

  const terminalInfo = frame[4];

  const voltage = frame[5];

  const gsmSignal = frame[6];

  /*
    GT06 Terminal Information bits:

    Bit 7 = oil/electricity disconnected
    Bit 6 = GPS positioned
    Bits 3-5 = alarm
    Bit 2 = charging
    Bit 1 = ACC
    Bit 0 = defense

    Therefore:

    ACC ON  = terminalInfo & 0x02
    ACC OFF = terminalInfo & 0x02 === 0

    Your 0x45:

    0100 0101
           ^
           bit 1 = 0

    Therefore ACC OFF.
  */

  const ignition =
    (terminalInfo & 0x02) !== 0;

  const gpsPositioned =
    (terminalInfo & 0x40) !== 0;

  const charging =
    (terminalInfo & 0x04) !== 0;

  const defense =
    (terminalInfo & 0x01) !== 0;

  const oilElectricityDisconnected =
    (terminalInfo & 0x80) !== 0;

  const alarmCode =
    (terminalInfo >> 3) & 0x07;

  const status = {
    imei,

    terminalInfo,

    ignition,

    gpsPositioned,

    charging,

    defense,

    oilElectricityDisconnected,

    alarmCode,

    voltage,

    gsmSignal,

    receivedAt: new Date(),
  };

  /*
    Save latest status for this device.
  */

  deviceStatus.set(imei, status);

  console.log('');
  console.log('========================================');
  console.log('GT06 STATUS / HEARTBEAT');
  console.log('========================================');

  console.log('IMEI:', imei);

  console.log(
    'Terminal Info:',
    `0x${terminalInfo
      .toString(16)
      .padStart(2, '0')}`
  );

  console.log(
    'ACC / IGNITION:',
    ignition ? 'ON' : 'OFF'
  );

  console.log(
    'GPS:',
    gpsPositioned ? 'POSITIONED' : 'NOT POSITIONED'
  );

  console.log(
    'Charging:',
    charging ? 'ON' : 'OFF'
  );

  console.log(
    'Defense:',
    defense ? 'ON' : 'OFF'
  );

  console.log(
    'Oil/Electricity:',
    oilElectricityDisconnected
      ? 'DISCONNECTED'
      : 'CONNECTED'
  );

  console.log('Voltage level:', voltage);
  console.log('GSM signal:', gsmSignal);

  console.log('========================================');
  console.log('');

  return status;
}

/* =========================================================
   PUBLISH LOCATION TO BACKEND
========================================================= */

async function publish(location) {
  if (!secret) {
    console.warn(
      'INGEST_SECRET is missing. Location not sent.'
    );

    return;
  }

  try {
    console.log(
      `Sending location to ${apiUrl}/ingest/location`
    );

    const response = await fetch(
      `${apiUrl}/ingest/location`,
      {
        method: 'POST',

        headers: {
          'content-type': 'application/json',
          'x-ingest-secret': secret,
        },

        body: JSON.stringify(location),
      }
    );

    const responseText =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `API returned ${response.status}: ${responseText}`
      );
    }

    console.log(
      `GPS SAVED ${location.imei}: ` +
      `${location.lat.toFixed(5)}, ` +
      `${location.lng.toFixed(5)}`
    );

    console.log(
      `Speed: ${location.speed} km/h`
    );

    console.log(
      `Ignition: ${
        location.ignition === true
          ? 'ON'
          : location.ignition === false
            ? 'OFF'
            : 'UNKNOWN'
      }`
    );

    console.log(
      `Backend response: ${response.status}`
    );
  } catch (error) {
    console.error(
      'Publish error:',
      error.message
    );
  }
}

/* =========================================================
   PROCESS GT06 FRAMES
========================================================= */

function processFrames(socket) {
  let buffer =
    socket._gt06Buffer ||
    Buffer.alloc(0);

  while (buffer.length >= 10) {
    /*
      Find 78 78
    */

    const start =
      buffer.indexOf(
        Buffer.from([0x78, 0x78])
      );

    if (start < 0) {
      buffer = Buffer.alloc(0);
      break;
    }

    /*
      Remove garbage before 78 78
    */

    if (start > 0) {
      buffer =
        buffer.subarray(start);
    }

    if (buffer.length < 3) {
      break;
    }

    /*
      Length byte
    */

    const length = buffer[2];

    /*
      GT06 total frame size:

      2 start
      + 1 length
      + length
      + 2 stop

      = length + 5
    */

    const total = length + 5;

    if (buffer.length < total) {
      break;
    }

    const frame =
      buffer.subarray(0, total);

    buffer =
      buffer.subarray(total);

    /*
      Validate stop bytes
    */

    if (
      frame[total - 2] !== 0x0d ||
      frame[total - 1] !== 0x0a
    ) {
      console.log(
        'Invalid frame:',
        frame.toString('hex').toUpperCase()
      );

      continue;
    }

    /*
      Protocol
    */

    const protocol = frame[3];

    /*
      Serial number
    */

    const serial =
      frame.readUInt16BE(total - 6);

    console.log(
      `Received packet | protocol=0x${protocol
        .toString(16)
        .padStart(2, '0')} | length=${frame.length}`
    );

    console.log(
      `RAW: ${frame
        .toString('hex')
        .toUpperCase()}`
    );

    /* =====================================================
       LOGIN 0x01
    ===================================================== */

    if (protocol === 0x01) {
      socket.imei = bcd(
        frame.subarray(4, 12)
      );

      console.log(
        `Login: ${socket.imei}`
      );
    }

    /* =====================================================
       GPS 0x12
    ===================================================== */

    else if (protocol === 0x12) {
      console.log(
        'GPS packet received'
      );

      /*
        We need the 0x13 status to know ACC.

        If the tracker sends GPS before status,
        don't guess ignition.
      */

      if (!socket.imei) {
        console.warn(
          'GPS received before login. Ignoring packet.'
        );
      } else {
        const point =
          parseGps(
            frame,
            socket.imei
          );

        if (point) {
          /*
            If ignition is unknown, we still send the
            GPS point. The backend currently converts
            Boolean values, so to avoid storing a false
            value that we don't actually know, wait
            until status is available.
          */

          if (point.ignition === null) {
            console.warn(
              `GPS received for ${point.imei}, ` +
              `but ACC status is not known yet.`
            );

            console.warn(
              'Waiting for 0x13 heartbeat before saving.'
            );
          } else {
            publish(point);
          }
        } else {
          console.log(
            'GPS packet could not be parsed'
          );
        }
      }
    }

    /* =====================================================
       STATUS / HEARTBEAT 0x13
    ===================================================== */

    else if (protocol === 0x13) {
      if (!socket.imei) {
        console.warn(
          'Status packet received before login.'
        );
      } else {
        parseStatus(
          frame,
          socket.imei
        );
      }
    }

    /*
      Always ACK the tracker.
    */

    socket.write(
      ack(
        protocol,
        serial
      )
    );
  }

  socket._gt06Buffer = buffer;
}

/* =========================================================
   TCP SERVER
========================================================= */

const server =
  net.createServer(
    (socket) => {
      console.log(
        'Tracker connected',
        socket.remoteAddress
      );

      socket.on(
        'data',
        (chunk) => {
          socket._gt06Buffer =
            Buffer.concat([
              socket._gt06Buffer ||
                Buffer.alloc(0),

              chunk,
            ]);

          processFrames(socket);
        }
      );

      socket.on(
        'error',
        (error) => {
          console.warn(
            'Tracker error:',
            error.message
          );
        }
      );

      socket.on(
        'close',
        () => {
          console.log(
            `Tracker disconnected ${
              socket.imei || ''
            }`
          );

          /*
            Remove status when connection closes.
          */

          if (socket.imei) {
            deviceStatus.delete(
              socket.imei
            );
          }
        }
      );
    }
  );

server.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `GT06 TCP listener on 0.0.0.0:${port}`
    );

    console.log(
      `API URL: ${apiUrl}`
    );
  }
);
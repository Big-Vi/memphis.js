const net = require('net');
const events = require('events');
const broker = require('nats');
const { v4: uuidv4 } = require('uuid');
const httpRequest = require('./httpRequest');

const retentionTypes = {
    MAX_MESSAGE_AGE_SECONDS: "message_age_sec",
    MESSAGES: "messages",
    BYTES: "bytes"
};

const storageTypes = {
    FILE: "file",
    MEMORY: "memory"
};

class Memphis {
    constructor() {
        this.isConnectionActive = false;
        this.connectionId = null;
        this.accessToken = null;
        this.host = null;
        this.port = 9000;
        this.username = null;
        this.brokerHost = null;
        this.brokerPort = 7766
        this.connectionToken = null;
        this.accessTokenTimeout = null;
        this.client = new net.Socket();
        this.reconnectAttempts = 0;
        this.reconnect = true;
        this.maxReconnect = 3;
        this.reconnectIntervalMs = 200;
        this.timeoutMs = 15000;
        this.brokerConnection

        this.client.on('error', error => {
            console.error(error);
        });

        this.client.on('close', () => {
            this.isConnectionActive = false;
            this._close();
        });
    }

    /**
        * Creates connection with Memphis. 
        * @param {String} host - control plane host.
        * @param {Number} port - control plane port, default is 9000.
        * @param {String} brokerHost - broker host.
        * @param {Number} brokerPort - broker port, default is 7766 .
        * @param {String} username - application type username.
        * @param {String} connectionToken - broker token.
        * @param {Boolean} reconnect - whether to do reconnect while connection is lost.
        * @param {Number} maxReconnect - The reconnect attempts.
        * @param {Number} reconnectIntervalMs - Interval in miliseconds between reconnect attempts.
        * @param {Number} timeoutMs - connection timeout in miliseconds.
    */
    connect({ host, port = 9000, username, brokerHost, brokerPort = 7766, connectionToken, reconnect = true, maxReconnect = 3, reconnectIntervalMs = 200, timeoutMs = 15000 }) {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                if (!reconnect || this.reconnectAttempts === maxReconnect || !this.isConnectionActive)
                    reject(new Error("Connection timeout has reached"));
            }, timeoutMs);

            this.host = this._normalizeHost(host) + "/tcp";
            this.brokerHost = this._normalizeHost(brokerHost);
            this.port = port;
            this.brokerPort = brokerPort;
            this.username = username;
            this.connectionToken = connectionToken;
            this.reconnect = reconnect;
            this.maxReconnect = maxReconnect > 9 ? 9 : maxReconnect;
            this.reconnectIntervalMs = reconnectIntervalMs;
            this.timeoutMs = timeoutMs;

            this.client.connect(port, this.host, () => {
                this.client.write(JSON.stringify({
                    username: username,
                    broker_creds: connectionToken,
                    connection_id: this.connectionId
                }));

                this.client.on('data', async data => {
                    data = JSON.parse(data.toString())
                    this.connectionId = data.connection_id;
                    this.accessToken = data.access_token;
                    this._keepAcessTokenFresh(data.access_token_exp);
                    this.isConnectionActive = true;
                    this.reconnectAttempts = 0;

                    try {
                        const nc = await broker.connect({
                            servers: `${this.brokerHost}:${this.brokerPort}`,
                            reconnect: this.reconnect,
                            maxReconnectAttempts: this.reconnect ? this.maxReconnect : 0,
                            reconnectTimeWait: this.reconnectIntervalMs,
                            timeout: this.timeoutMs,
                            token: this.connectionToken
                        });

                        this.brokerConnection = nc.jetstream();
                        return resolve();
                    } catch (ex) {
                        return reject(ex);
                    }
                });
            });
        });
    }

    _normalizeHost(host) {
        if (host.startsWith("http://"))
            return host.split("http://")[1];
        else if (host.startsWith("https://"))
            return host.split("https://")[1];
        else
            return host;
    }

    _keepAcessTokenFresh(expiresIn) {
        this.accessTokenTimeout = setTimeout(() => {
            if (this.isConnectionActive)
                this.client.write(JSON.stringify({
                    resend_access_token: true
                }));
        }, expiresIn)
    }

    /**
        * Creates a factory. 
        * @param {String} name - factory name.
        * @param {String} description - factory description (optional).
    */
    async factory({ name, description = "" }) {
        try {
            if (!this.isConnectionActive)
                throw new Error("Connection is dead");

            const response = await httpRequest({
                method: "POST",
                url: `http://${this.host}:${this.port}/api/factories/createFactory`,
                headers: {
                    Authorization: "Bearer " + this.accessToken
                },
                bodyParams: { name, description },
            });

            return new Factory(this, response.name);
        } catch (ex) {
            throw ex;
        }
    }

    /**
        * Creates a station. 
        * @param {String} name - station name.
        * @param {String} factoryName - factory name to link the station with.
        * @param {Memphis.retentionTypes} retentionType - retention type, default is MAX_MESSAGE_AGE_SECONDS.
        * @param {Number} retentionValue - number which represents the retention based on the retentionType, default is 604800.
        * @param {Memphis.storageTypes} storageType - persistance storage for messages of the station, default is storageTypes.FILE.
        * @param {Number} replicas - number of replicas for the messages of the data, default is 1.
        * @param {Boolean} dedupEnabled - whether to allow dedup mecanism, dedup happens based on message ID, default is false.
        * @param {Number} dedupWindowMs - time frame in which dedup track messages, default is 0.
    */
    async station({ name, factoryName, retentionType = retentionTypes.MAX_MESSAGE_AGE_SECONDS, retentionValue = 604800, storageType = storageTypes.FILE, replicas = 1, dedupEnabled = false, dedupWindowMs = 0 }) {
        try {
            if (!this.isConnectionActive)
                throw new Error("Connection is dead");

            const response = await httpRequest({
                method: "POST",
                url: `http://${this.host}:${this.port}/api/stations/createStation`,
                headers: {
                    Authorization: "Bearer " + this.accessToken
                },
                bodyParams: {
                    name: name,
                    factory_name: factoryName,
                    retention_type: retentionType,
                    retention_value: retentionValue,
                    storage_type: storageType,
                    replicas: replicas,
                    dedup_enabled: dedupEnabled,
                    dedup_window_in_ms: dedupWindowMs
                },
            });

            return new Station(this, response.name);
        } catch (ex) {
            throw ex;
        }
    }

    /**
        * Creates a producer. 
        * @param {String} stationName - station name to produce messages into.
        * @param {Number} producerName - name for the producer.
    */
    async producer({ stationName, producerName }) {
        try {
            if (!this.isConnectionActive)
                throw new Error("Connection is dead");

            await httpRequest({
                method: "POST",
                url: `http://${this.host}:${this.port}/api/producers/createProducer`,
                headers: {
                    Authorization: "Bearer " + this.accessToken
                },
                bodyParams: {
                    name: producerName,
                    station_name: stationName,
                    connection_id: this.connectionId,
                    producer_type: "application"
                },
            });

            return new Producer(this, producerName, stationName);
        } catch (ex) {
            throw ex;
        }
    }

    /**
        * Creates a consumer. 
        * @param {String} stationName - station name to consume messages from.
        * @param {String} consumerName - name for the consumer.
        * @param {String} consumerGroup - consumer group name, default is "".
        * @param {Number} pullIntervalMs - interval in miliseconds between pulls, default is 1000.
        * @param {Number} batchSize - pull batch size.
        * @param {Number} batchMaxTimeToWaitMs - max time in miliseconds to wait between pulls, defauls is 5000.
    */
    async consumer({ stationName, consumerName, consumerGroup = "", pullIntervalMs = 1000, batchSize = 10, batchMaxTimeToWaitMs = 5000 }) {
        try {
            if (!this.isConnectionActive)
                throw new Error("Connection is dead");

            await httpRequest({
                method: "POST",
                url: `http://${this.host}:${this.port}/api/consumers/createConsumer`,
                headers: {
                    Authorization: "Bearer " + this.accessToken
                },
                bodyParams: {
                    name: consumerName,
                    station_name: stationName,
                    connection_id: this.connectionId,
                    consumer_type: "application",
                    consumers_group: consumerGroup
                },
            });

            return new Consumer(this, stationName, consumerName, consumerGroup, pullIntervalMs, batchSize, batchMaxTimeToWaitMs);
        } catch (ex) {
            throw ex;
        }
    }

    _close() {
        if (this.reconnect && this.reconnectAttempts < this.maxReconnect) {
            this.reconnectAttempts++;
            setTimeout(async () => {
                try {
                    await this.connect({
                        host: this.host,
                        port: this.port,
                        username: this.username,
                        connectionToken: this.connectionToken,
                        reconnect: this.reconnect,
                        maxReconnect: this.maxReconnect,
                        reconnectIntervalMs: this.reconnectIntervalMs,
                        timeoutMs: this.timeoutMs
                    });
                    console.log("Reconnect to memphis control plane has been succeeded");
                } catch (ex) {
                    console.error("Failed reconnect to memphis control plane");
                    return;
                }
            }, this.reconnectIntervalMs);
        }
        else {
            this.client.removeAllListeners("data");
            this.client.removeAllListeners("error");
            this.client.removeAllListeners("close");
            this.client.destroy();
            clearTimeout(this.accessTokenTimeout);
            this.accessToken = null;
            this.connectionId = null;
            this.isConnectionActive = false;
            this.accessTokenTimeout = null;
            this.reconnectAttempts = 0;
        }
    }

    /**
        * Close Memphis connection. 
    */
    close() {
        this.client.removeAllListeners("data");
        this.client.removeAllListeners("error");
        this.client.removeAllListeners("close");
        this.client.destroy();
        clearTimeout(this.accessTokenTimeout);
        this.accessToken = null;
        this.connectionId = null;
        this.isConnectionActive = false;
        this.accessTokenTimeout = null;
        this.reconnectAttempts = 0;
    }
}

class Producer {
    constructor(connection, producerName, stationName) {
        this.connection = connection;
        this.producerName = producerName.toLowerCase();
        this.stationName = stationName.toLowerCase();
    }

    /**
        * Produces a message into a station. 
        * @param {Uint8Array} message - message to send into the station.
        * @param {Number} ackWaitSec - max time in seconds to wait for an ack from memphis.
    */
    async produce({ message, ackWaitSec = 15 }) {
        try {
            await this.connection.publish(`${this.stationName}.final`, message, { msgID: uuidv4(), ackWait: ackWaitSec * 1000 * 1000 });
        } catch (ex) {
            throw ex;
        }
    }

    /**
        * Destroy the producer. 
    */
    async destroy() {
        try {
            await httpRequest({
                method: "POST",
                url: `http://${this.connection.host}/api/producers/destroyProducer`,
                headers: {
                    Authorization: "Bearer " + this.connection.accessToken
                },
                bodyParams: {
                    name: this.consumerName,
                    station_name: this.stationName
                },
            });
        } catch (ex) {
            throw ex;
        }
    }
}

class Consumer {
    constructor(connection, stationName, consumerName, consumerGroup, pullIntervalMs, batchSize, batchMaxTimeToWaitMs) {
        this.connection = connection;
        this.stationName = stationName.toLowerCase();
        this.consumerName = consumerName.toLowerCase();
        this.consumerGroup = consumerGroup.toLowerCase();
        this.pullIntervalMs = pullIntervalMs;
        this.batchSize = batchSize;
        this.batchMaxTimeToWaitMs = batchMaxTimeToWaitMs;
        this.eventEmitter = new events.EventEmitter();
        this.on = new events.EventEmitter().on;
        this.pullInterval = null;

        this.connection.pullSubscribe(`${this.stationName}.final`, {
            mack: true,
            config: {
                durable_name: this.consumerGroup ? this.consumerGroup : this.consumerName,
                ack_wait: nanos(4000),
            },
        }).then(async psub => {
            psub.pull({ batch: this.batchSize, expires: this.batchMaxTimeToWaitMs });
            this.pullInterval = setInterval(() => {
                psub.pull({ batch: this.batchSize, expires: this.batchMaxTimeToWaitMs });
            }, this.pullIntervalMs);

            for await (const m of psub) {
                this.eventEmitter.emit("message", new Message(m));
            }

        }).catch(error => this.eventEmitter.emit("error", error));
    }

    /**
        * Destroy the consumer. 
    */
    async destroy() {
        this.eventEmitter.removeAllListeners("message");
        this.eventEmitter.removeAllListeners("error");
        clearInterval(this.pullInterval);
        try {
            await httpRequest({
                method: "POST",
                url: `http://${this.connection.host}/api/consumers/destroyConsumer`,
                headers: {
                    Authorization: "Bearer " + this.connection.accessToken
                },
                bodyParams: {
                    name: this.consumerName,
                    station_name: this.stationName
                },
            });
        } catch (ex) {
            throw ex;
        }
    }
}

class Message {
    constructor(message) {
        this.message = message;
    }

    /**
        * Ack a message is done processing. 
    */
    ack() {
        this.message.ack();
    }
}

class Factory {
    constructor(connection, name) {
        this.connection = connection;
        this.name = name.toLowerCase();
    }

    /**
        * Destroy the factory. 
    */
    async destroy() {
        try {
            await httpRequest({
                method: "POST",
                url: `http://${this.connection.host}/api/factories/removeFactory`,
                headers: {
                    Authorization: "Bearer " + this.connection.accessToken
                },
                bodyParams: {
                    factory_name: this.name
                },
            });
        } catch (ex) {
            throw ex;
        }
    }
}

class Station {
    constructor(connection, name) {
        this.connection = connection;
        this.name = name.toLowerCase();
    }

    /**
       * Destroy the station. 
   */
    async destroy() {
        try {
            await httpRequest({
                method: "POST",
                url: `http://${this.connection.host}/api/stations/removeStation`,
                headers: {
                    Authorization: "Bearer " + this.connection.accessToken
                },
                bodyParams: {
                    station_name: this.name
                },
            });
        } catch (ex) {
            throw ex;
        }
    }
}

module.exports = () => new Memphis()
module.exports.retentionTypes = retentionTypes;
module.exports.storageTypes = storageTypes;
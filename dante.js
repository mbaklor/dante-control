const dgram = require("dgram");
const mdns = require("multicast-dns")();
const merge = require("./utils/merge");
const EventEmitter = require('events');

// const danteServiceTypes = ["_netaudio-cmc._udp", "_netaudio-dbc._udp", "_netaudio-arc._udp", "_netaudio-chan._udp"];
const danteQuery = '_netaudio-arc._udp.local'
const danteControlPort = 4440;
const sequenceId1 = Buffer.from([0x29]);
const danteConstant = Buffer.from([0x27]);

function reverse(s) {
    return s.split("").reverse().join("");
}

const getRandomInt = (max) => {
    return Math.floor(Math.random() * max);
};

const intToBuffer = (int) => {
    let intBuffer = Buffer.alloc(2);
    intBuffer.writeUInt16BE(int);
    return intBuffer;
};

const bufferToInt = (buffer) => {
    return buffer.readUInt16BE();
};

const parseChannelCount = (reply) => {
    const channelInfo = { channelCount: { tx: reply[13], rx: reply[15] } };
    return channelInfo;
};

const parseTxChannelNames = (reply) => {
    const names = { channelNames: { tx: [] } };
    const namesString = reply.toString();
    const channelsCount = reply[10];
    const endOfSearch = namesString.lastIndexOf(String.fromCharCode(0x0e));
    names.channelNames.tx = namesString.substring(endOfSearch + 1).split(String.fromCharCode(0x00), channelsCount);
    // let name = "";
    //
    // for (let i = endOfSearch + 1; i < namesString.length; i++) {
    //     if (reply[i] === 0) {
    //         console.log(name);
    //         names.channelNames.tx.push(name);
    //         name = "";
    //     } else {
    //         name += namesString[i];
    //     }
    // }

    return names;
};

class Dante extends EventEmitter {
    constructor() {
        super();
        this.debug = false;
        this.devices;
        this.devicesList = [];
        this.socket = dgram.createSocket("udp4");

        this.socket.on("message", this.parseReply.bind(this));
        this.socket.bind(0); /* don't want to bind the dante control port as it's blocked by DVS,
                                instead we take random port allocated by the OS and only send messages to the dante control port
                                this is what I've seen the dante controller app do, and in testing it works */

        mdns.on("response", this.parseDevices.bind(this));
    }

    parseDevices(res, rinfo) {
        const answer = res?.answers?.[0];

        if (answer?.name?.includes(danteQuery) & answer?.type == 'PTR') {
            const name = answer.data.replace(`.${danteQuery}`, '');
            if (this.devicesList.findIndex(x => x.name === name) == -1) {
                this.devicesList.push({
                    name: name,
                    address: rinfo.address

                });
                this.emit('newDevice', this.devicesList.at(-1));
            }
        }

    }

    parseReply(reply, rinfo) {
        const deviceIP = rinfo.address;
        const replySize = rinfo.size;
        let deviceData = {};
        const devIndex = this.devicesList.findIndex(x => x.address === deviceIP);
        if (this.debug) {
            // Log replies when in debug mode
            console.log(`Rx (${reply.length}): ${reply.toString("hex")}`);
        }

        if (reply[0] === danteConstant[0] && reply[1] === sequenceId1[0]) {
            if (replySize === bufferToInt(reply.slice(2, 4))) {
                const commandId = reply.slice(6, 8);
                switch (bufferToInt(commandId)) {
                    case 4096:
                        deviceData = parseChannelCount(reply);
                        break;
                    case 8192:
                        deviceData = parseTxChannelNames(reply);
                        break;
                }

                if (devIndex > -1) {
                    this.devicesList[devIndex] = { ...this.devicesList[devIndex], ...deviceData };
                    this.emit('devicesUpdated', this.devicesList[devIndex]);
                }
                if (this.debug) {
                    // Log parsed device information when in debug mode
                    console.log(this.devicesList[devIndex]);
                }
            }
        }
    }

    sendCommand(command, host, port = danteControlPort) {
        if (this.debug) {
            // Log sent bytes when in debug mode
            console.log(`Tx (${command.length}): ${command.toString("hex")}`);
        }

        this.socket.send(command, 0, command.length, port, host);
    }

    makeCommand(command, commandArguments = Buffer.alloc(2)) {
        let sequenceId2 = Buffer.alloc(2);
        sequenceId2.writeUInt16BE(getRandomInt(65535));

        const padding = Buffer.from([0x00, 0x00]);
        let commandLength = Buffer.alloc(2);
        let commandId = Buffer.alloc(2);

        switch (command) {
            case "channelCount":
                commandId = Buffer.from("1000", "hex");
                break;
            case "deviceInfo":
                commandId = Buffer.from("1003", "hex");
                break;
            case "deviceName":
                commandId = Buffer.from("1002", "hex");
                break;
            case "subscription":
                commandId = Buffer.from("3010", "hex");
                break;
            case "rxChannelNames":
                commandId = Buffer.from("3000", "hex");
                break;
            case "txChannelNames":
                commandId = Buffer.from("2000", "hex"); // in testing, sniffing packets from dante controller, looks like 2000 is the correct command id
                break;
            case "setRxChannelName":
                commandId = Buffer.from([0x30, 0x01]);
                break;
            case "setTxChannelName":
                commandId = Buffer.from([0x20, 0x13]);
                break;
            case "setDeviceName":
                commandId = Buffer.from([0x10, 0x01]);
                break;
        }

        commandLength.writeUInt16BE(
            Buffer.concat([
                danteConstant,
                sequenceId1,
                sequenceId2,
                commandId,
                Buffer.alloc(2),
                commandArguments,
                Buffer.alloc(1),
            ]).length + 2
        );

        return Buffer.concat([
            danteConstant,
            sequenceId1,
            commandLength,
            sequenceId2,
            commandId,
            Buffer.alloc(2),
            commandArguments,
            Buffer.alloc(1),
        ]);
    }

    resetDeviceName(ipaddress) {
        const commandBuffer = this.makeCommand("setDeviceName");
        this.sendCommand(commandBuffer, ipaddress);
    }

    setDeviceName(ipaddress, name) {
        const commandBuffer = this.makeCommand("setDeviceName", Buffer.from(name, "ascii"));
        this.sendCommand(commandBuffer, ipaddress);
    }

    setChannelName(ipaddress, channelNumber = 0, channelType = "rx", channelName = "") {
        const channelNameBuffer = Buffer.from(channelName, "ascii");
        let commandBuffer = Buffer.alloc(1);
        let channelNumberBuffer = Buffer.alloc(2);
        channelNumberBuffer.writeUInt16BE(channelNumber);

        if (channelType === "rx") {
            const commandArguments = Buffer.concat([
                Buffer.from("0401", "hex"),
                channelNumberBuffer,
                Buffer.from("001c", "hex"),
                Buffer.alloc(12),
                channelNameBuffer,
            ]);
            commandBuffer = this.makeCommand("setRxChannelName", commandArguments);
        } else if (channelType === "tx") {
            const commandArguments = Buffer.concat([
                Buffer.from("040100000", "hex"),
                channelNumberBuffer,
                Buffer.from("0024", "hex"),
                Buffer.alloc(18),
                channelNameBuffer,
            ]);
            commandBuffer = this.makeCommand("setTxChannelName", commandArguments);
        } else {
            throw "Invalid Channel Type - must be 'tx' or 'rx'";
        }
        this.sendCommand(commandBuffer, ipaddress);
    }

    resetChannelName(ipaddress, channelNumber = 0, channelType = "rx") {
        this.setChannelName(ipaddress, "", channelType, channelNumber);
    }

    makeSubscription(ipaddress, destinationChannelNumber = 0, sourceChannelName, sourceDeviceName) {
        const sourceChannelNameBuffer = Buffer.from(sourceChannelName, "ascii");
        const sourceDeviceNameBuffer = Buffer.from(sourceDeviceName, "ascii");

        const commandArguments = Buffer.concat([
            Buffer.from("0401", "hex"),
            intToBuffer(destinationChannelNumber),
            Buffer.from("005c005f", "hex"),
            Buffer.alloc(83 - sourceChannelNameBuffer.length - sourceDeviceNameBuffer.length),
            sourceChannelNameBuffer,
            Buffer.alloc(1),
            sourceDeviceNameBuffer,
        ]);

        const commandBuffer = this.makeCommand("subscription", commandArguments);

        this.sendCommand(commandBuffer, ipaddress);
    }

    clearSubscription(ipaddress, destinationChannelNumber = 0) {
        const commandArguments = Buffer.concat([
            Buffer.from("0401", "hex"),
            intToBuffer(destinationChannelNumber),
            Buffer.alloc(77),
        ]);

        const commandBuffer = this.makeCommand("subscription", commandArguments);

        this.sendCommand(commandBuffer, ipaddress);
    }

    getChannelCount(ipaddress) {
        const devIndex = this.devicesList.findIndex(x => x.address === ipaddress);
        const commandBuffer = this.makeCommand("channelCount");
        this.sendCommand(commandBuffer, ipaddress);
        if (devIndex > -1) {
            if (this.debug) console.log((({ address, channelCount }) => ({ address, channelCount }))(this.devicesList[devIndex]));
            return this.devicesList[devIndex]?.channelCount;
        }
    }

    getChannelNames(ipaddress) {
        const devIndex = this.devicesList.findIndex(x => x.address === ipaddress);
        const commandBuffer = this.makeCommand("txChannelNames", Buffer.from("0001000100", "hex"));
        this.sendCommand(commandBuffer, ipaddress);
        if (devIndex > -1) {
            if (this.debug) console.log((({ address, channelNames }) => ({ address, channelNames }))(this.devicesList[devIndex]));
            return this.devices[devIndex]?.channelNames;
        }

    }

    get devices() {
        return this.devicesList;
    }
}

module.exports = Dante;

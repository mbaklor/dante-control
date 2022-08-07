const dgram = require("dgram");
const Mdns = require("multicast-dns");
const EventEmitter = require("events");

const danteServiceTypes = ["_netaudio-cmc._udp", "_netaudio-dbc._udp", "_netaudio-arc._udp", "_netaudio-chan._udp"];
const danteQuery = "_netaudio-arc._udp.local";
const danteControlPort = 4440;
const sequenceId1 = Buffer.from([0x29]);
const danteConstant = Buffer.from([0x27]);

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

const readFromBuffer = (buffer, stringStart) => {
    stringEnd = buffer.indexOf(0, stringStart);
    return buffer.subarray(stringStart, stringEnd).toString();
};

const parseDeviceInfo = (reply, device) => {
    let changed = false;
    const replyString = reply.toString();
    const nameStartIndex = replyString.indexOf(String.fromCharCode(0x10, 0x04));
    const nameStart = replyString.substring(nameStartIndex + 2, nameStartIndex + 40);
    const nameEndIndex = nameStart.lastIndexOf(String.fromCharCode(0));
    let name = nameStart.substring(0, nameEndIndex);
    name = name.split(String.fromCharCode(0)).join("");
    if (device.name != name) {
        device.name = name;
        changed = true;
    }
    return changed;
};

const parseChannelCount = (reply, device) => {
    let changed = false;
    let txCount = reply.subarray(12, 14);
    let rxCount = reply.subarray(14, 16);
    if (device.channelCount.tx != txCount || device.channelCount.rx != rxCount) {
        device.channelCount.tx = bufferToInt(txCount);
        device.channelCount.rx = bufferToInt(rxCount);
        changed = true;
    }
    return changed;
};

const parseTxChannelNames = (reply, device) => {
    let changed = false;
    const channelsCount = reply[11];
    let start = 12;
    let txName;
    let chIndex;
    const channels = [];
    for (let i = 0; i < channelsCount; i++) {
        channels.push(reply.subarray(start, start + 8));
        chIndex = bufferToInt(channels[i].subarray(0, 2));
        txName = rxName = readFromBuffer(reply, bufferToInt(channels[i].subarray(6, 8)));
        start = start + 8;

        if (device.channels.tx[chIndex - 1] != txName) {
            device.channels.tx[chIndex - 1] = txName;
            changed = true;
        }
    }

    return changed;
};

const parseRxChannelNames = (reply, device) => {
    let changed = false;
    const channelsCount = reply[10];
    let template = {
        name: "",
        status: "",
        txDevice: "",
        txChannel: "",
    };
    const statuses = new Map();
    statuses.set(0, false);
    statuses.set(1, "unresolved");
    statuses.set(9, true);
    statuses.set(16, "Incorrect channel format");
    statuses.set(18, "no flows");

    const audio = ["no audio", true];

    let start = 12;
    let chIndex;
    let status;
    let rxName;
    let txChannel;
    let txDevice;
    const channels = [];
    for (let i = 0; i < channelsCount; i++) {
        channels.push(reply.subarray(start, start + 20));
        chIndex = bufferToInt(channels[i].subarray(0, 2));
        status = statuses.get(bufferToInt(channels[i].subarray(14, 16)));
        if (status === true) {
            status = audio[channels[i][13]];
        }
        rxName = readFromBuffer(reply, bufferToInt(channels[i].subarray(10, 12)));
        start = start + 20;
        if (!status) {
            txChannel = "";
            txDevice = "";
        } else {
            txChannel = readFromBuffer(reply, bufferToInt(channels[i].subarray(6, 8)));

            txDevice = readFromBuffer(reply, bufferToInt(channels[i].subarray(8, 10)));
        }

        template.name = rxName;
        template.status = status;
        template.txDevice = txDevice;
        template.txChannel = txChannel;
        if (device.channels.rx[chIndex - 1] != template) {
            device.channels.rx[chIndex - 1] = Object.assign({}, template);
            changed = true;
        }
    }

    return changed;
};

class Dante extends EventEmitter {
    #devicesList = [{}];
    #debug;
    constructor(ipinterface) {
        super();
        this.mdns = new Mdns({
            interface: ipinterface,
        });
        this.#debug = false;
        this.#devicesList = [];

        this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

        this.socket.on("message", this.#parseReply.bind(this));

        this.udpclients = [8700, 8701, 8702, 8703, 8704, 8705, 8706, 8707];
        this.udpsockets = [];

        this.udpclients.forEach(
            function (port) {
                var udpServer = dgram.createSocket({ type: "udp4", reuseAddr: true });
                udpServer.bind(port, () => {
                    udpServer.setMulticastLoopback = true;
                    udpServer.addMembership("224.0.0.230", ipinterface);
                    udpServer.addMembership("224.0.0.231", ipinterface);
                    udpServer.addMembership("224.0.0.232", ipinterface);
                    udpServer.addMembership("224.0.0.233", ipinterface);
                });
                udpServer.on("message", this.#parseMulticast.bind(this));
            }.bind(this)
        );

        this.socket.bind(0); /*  don't want to bind the dante control port as it's blocked by DVS,
                instead we take random port allocated by the OS and only send messages to the dante control port
                this is what I've seen the dante controller app do, and in testing it works */

        this.mdns.on("response", this.#parseDevices.bind(this));
        this.mdns.query({
            questions: [
                {
                    name: danteQuery,
                    type: "PTR",
                },
            ],
        });
    }

    #parseMulticast(res, rinfo) {
        const multicastHeader = Buffer.from([0xff, 0xff]);
        const deviceIP = rinfo.address;
        const replySize = rinfo.size;
        const devIndex = this.#devicesList.findIndex((x) => x.address === deviceIP);

        if (res[0] === multicastHeader[0] && res[1] === multicastHeader[1]) {
            if (replySize === bufferToInt(res.subarray(2, 4))) {
                const commandId = res.subarray(26, 28);

                switch (bufferToInt(commandId)) {
                    case 257:
                        this.getChannelNames(deviceIP, "tx");
                        // console.log("tx change");
                        break;
                    case 258:
                        this.getChannelNames(deviceIP, "rx");
                        // console.log("rx change");
                        break;
                    case 262:
                        this.getDeviceInfo(deviceIP);
                        // console.log("name change");
                        break;
                }
            }
        }
    }

    #parseDevices(res, rinfo) {
        let firstSuccess = false;
        const answers = res?.answers;
        answers.every((answer) => {
            if (firstSuccess) {
                return false;
            }
            const isDante = danteServiceTypes.some((danteService) => {
                if (answer?.name.includes(danteService)) {
                    return true;
                } else {
                    return false;
                }
            });

            if (isDante & (answer?.type == "PTR") & !answer?.name.includes("_sub")) {
                const devIndex = this.#devicesList.findIndex((x) => x.address === rinfo.address);
                if (answer?.data.includes("@")) {
                    return false;
                }
                if (devIndex === -1) {
                    this.#devicesList.push({
                        address: rinfo.address,
                        name: "",
                        channelCount: {
                            tx: 0,
                            rx: 0,
                        },
                        channels: {
                            tx: [],
                            rx: [],
                        },
                    });
                    this.getDeviceInfo(rinfo.address);
                    this.getChannelCount(rinfo.address);
                    this.on("channelCountRead", (res) => {
                        if (res.address === rinfo.address) {
                            this.getChannelNames(rinfo.address, "tx");
                            this.getChannelNames(rinfo.address, "rx");
                        }
                    });
                } else {
                    const name = answer?.data.replace(`.${answer?.name}`, "");
                    if (this.#devicesList[devIndex]?.name != name) {
                        firstSuccess = true;
                        this.getDeviceInfo(rinfo.address);
                    }
                }
                this.emit("gotDevice", this.#devicesList.at(devIndex));
            }
            return true;
        });
    }

    #parseReply(reply, rinfo) {
        const deviceIP = rinfo.address;
        const replySize = rinfo.size;
        let changed;
        const devIndex = this.#devicesList.findIndex((x) => x.address === deviceIP);
        if (this.#debug) {
            // Log replies when in debug mode
            console.log(`Rx (${reply.length}): ${reply.toString("hex")}`);
        }

        if (reply[0] === danteConstant[0] && reply[1] === sequenceId1[0]) {
            if (replySize === bufferToInt(reply.slice(2, 4))) {
                const commandId = reply.slice(6, 8);
                switch (bufferToInt(commandId)) {
                    case 4096:
                        changed = parseChannelCount(reply, this.#devicesList[devIndex]);
                        this.emit(`channelCountRead`, this.#devicesList[devIndex]);

                        break;
                    case 8192:
                        changed = parseTxChannelNames(reply, this.#devicesList[devIndex]);
                        this.emit(`txChannelNamesRead`, this.#devicesList[devIndex]);
                        break;
                    case 12288:
                        changed = parseRxChannelNames(reply, this.#devicesList[devIndex]);
                        this.emit(`rxChannelNamesRead`, this.#devicesList[devIndex]);
                        break;
                    case 4099:
                        changed = parseDeviceInfo(reply, this.#devicesList[devIndex]);
                        this.emit(`deviceNameRead`, this.#devicesList[devIndex]);
                        break;
                }
                if (this.#debug) {
                    // Log parsed device information when in debug mode
                    console.log(this.#devicesList[devIndex]);
                }
            }
        }
    }

    #sendCommand(command, host, port = danteControlPort) {
        if (this.#debug) {
            // Log sent bytes when in debug mode
            console.log(`Tx (${command.length}): ${command.toString("hex")}`);
        }

        this.socket.send(command, 0, command.length, port, host);
    }

    #makeCommand(command, commandArguments = Buffer.alloc(2)) {
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
            Buffer.concat([danteConstant, sequenceId1, sequenceId2, commandId, Buffer.alloc(2), commandArguments, Buffer.alloc(1)]).length + 2
        );

        return Buffer.concat([danteConstant, sequenceId1, commandLength, sequenceId2, commandId, Buffer.alloc(2), commandArguments, Buffer.alloc(1)]);
    }

    getDeviceInfo(ipaddress) {
        const commandBuffer = this.#makeCommand("deviceInfo");
        this.#sendCommand(commandBuffer, ipaddress);
    }

    setDeviceName(ipaddress, name) {
        const commandBuffer = this.#makeCommand("setDeviceName", Buffer.from(name, "ascii"));
        this.#sendCommand(commandBuffer, ipaddress);
    }

    resetDeviceName(ipaddress) {
        const commandBuffer = this.#makeCommand("setDeviceName");
        this.#sendCommand(commandBuffer, ipaddress);
    }

    getChannelCount(ipaddress) {
        const devIndex = this.#devicesList.findIndex((x) => x.address === ipaddress);
        const commandBuffer = this.#makeCommand("channelCount");
        this.#sendCommand(commandBuffer, ipaddress);
        if (devIndex > -1) {
            if (this.#debug)
                console.log(
                    (({ address, channelCount }) => ({
                        address,
                        channelCount,
                    }))(this.#devicesList[devIndex])
                );
            return this.#devicesList[devIndex]?.channelCount;
        }
    }

    getChannelNames(ipaddress, channelType = "tx") {
        const devIndex = this.#devicesList.findIndex((x) => x.address === ipaddress);
        let command;
        let channelCount = this.#devicesList[devIndex]?.channelCount?.[channelType];
        for (let i = 1; i < channelCount; i += 16) {
            command = Buffer.concat([Buffer.from("0001", "hex"), Buffer.from(intToBuffer(i)), Buffer.alloc(1)]);
            const commandBuffer = this.#makeCommand(`${channelType}ChannelNames`, command);
            this.#sendCommand(commandBuffer, ipaddress);
            if (channelType == "tx") i += 16;
        }
        if (devIndex > -1) {
            if (this.#debug)
                console.log(
                    (({ address, channelNames }) => ({
                        address,
                        channelNames,
                    }))(this.#devicesList[devIndex])
                );
            return this.#devicesList[devIndex]?.channelNames;
        }
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
            commandBuffer = this.#makeCommand("setRxChannelName", commandArguments);
        } else if (channelType === "tx") {
            const commandArguments = Buffer.concat([
                Buffer.from("040100000", "hex"),
                channelNumberBuffer,
                Buffer.from("0024", "hex"),
                Buffer.alloc(18),
                channelNameBuffer,
            ]);
            commandBuffer = this.#makeCommand("setTxChannelName", commandArguments);
        } else {
            throw "Invalid Channel Type - must be 'tx' or 'rx'";
        }
        this.#sendCommand(commandBuffer, ipaddress);
    }

    resetChannelName(ipaddress, channelNumber = 0, channelType = "rx") {
        this.setChannelName(ipaddress, channelNumber, channelType);
    }

    makeSubscription(ipaddress, destinationChannelNumber = 0, sourceChannelName, sourceDeviceName) {
        const sourceChannelNameBuffer = Buffer.from(sourceChannelName, "ascii");
        const sourceDeviceNameBuffer = Buffer.from(sourceDeviceName, "ascii");

        const commandArguments = Buffer.concat([
            Buffer.from("0401", "hex"),
            intToBuffer(destinationChannelNumber),
            Buffer.from("005c", "hex"),
            intToBuffer(93 + sourceChannelNameBuffer.length),
            Buffer.alloc(74),
            sourceChannelNameBuffer,
            Buffer.alloc(1),
            sourceDeviceNameBuffer,
        ]);
        const commandBuffer = this.#makeCommand("subscription", commandArguments);

        this.#sendCommand(commandBuffer, ipaddress);
    }

    clearSubscription(ipaddress, destinationChannelNumber = 0) {
        const commandArguments = Buffer.concat([Buffer.from("0401", "hex"), intToBuffer(destinationChannelNumber), Buffer.alloc(77)]);

        const commandBuffer = this.#makeCommand("subscription", commandArguments);

        this.#sendCommand(commandBuffer, ipaddress);
    }

    get devices() {
        return this.#devicesList;
    }

    /**
     * @param {boolean} value
     */
    set debug(value) {
        if (typeof value == "boolean") {
            this.#debug = value;
        } else {
            // throw "invalid type, debug muse be boolean"
        }
    }
}

module.exports = Dante;

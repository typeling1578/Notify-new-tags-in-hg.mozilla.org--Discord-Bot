import HTMLParser from "node-html-parser";
import fs from "fs";
import http from "http";
import got from "got";
import mastodon from "mastodon";

let known_tags = {};
let known_tags_all = [];
let known_tags_all_mastodon = [];
let config;
let mastodon_api_client = null;

(async() => {
    let config_file;
    if (process.env.NOTIFY_NEW_TAGS_IN_HG_MOZILLA_ORG_DISCORD_BOT_CONFIG) {
        config_file = process.env.NOTIFY_NEW_TAGS_IN_HG_MOZILLA_ORG_DISCORD_BOT_CONFIG;
    } else {
        config_file = await new Promise((resolve, reject) => {
            fs.readFile("config.json", "utf-8", function(err, data) {
                if (err) { reject(err) }
                resolve(data);
            });
        });
    }
    config = JSON.parse(config_file);

    console.log(`config\n${config_file}`);

    if (config.receive_ping_server_enabled) {
        http.createServer(function(request, response)
        {
            response.writeHead(200, {'Content-Type': 'text/plain'});
            response.end('pong');
        }).listen(Number(process.env.PORT || 8080));
    }    

    let check_repos = config["check_repos"];

    for (let check_repo of check_repos) {
        await init_sync_hg_mozilla_org(check_repo);
    }

    let check_ended = true;
    setInterval(async function () {
        if (!check_ended) {
            console.warn("Warning: Jobs are accumulating unprocessed. Please improve the performance of the machine or reduce the number of repositories to check.");
            return;
        }
        check_ended = false;
        for (let check_repo of check_repos) {
            try {
                await sync_hg_mozilla_org(check_repo);
            } catch (e) { console.error(e) }
        }
        check_ended = true;
    }, 60000);
})();

function httpRequest(url, options) {
    return got(url, Object.assign({
        timeout: {
            request: 10000
        }
    }, options)).text();
}

async function post_discord(message, webhook) {
    let body = {
        "content": message
    }
    await httpRequest(webhook, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
}

async function post_mastodon(message) {
    if (!mastodon_api_client) {
        mastodon_api_client = new mastodon({
            access_token: config["mastodon_access_token"],
            timeout: 60 * 1000,
            api_url: config["mastodon_endpoint"],
        });
    }
    await new Promise((resolve, reject) => {
        mastodon_api_client.post("statuses", { status: message }, function(err, data, res) {
            if (err) reject(err);
            resolve();
        });
    });
}

async function init_sync_hg_mozilla_org(path) {
    console.log(`Initial synchronizing "${path}"`);
    const url = "https://hg.mozilla.org/" + path + "/tags";
    const result_text = await httpRequest(url);
    const root = HTMLParser.parse(result_text);
    const elems = root.querySelectorAll(".list");
    known_tags[path] = [];
    for (let elem of elems) {
        let tag = elem.textContent;
        known_tags[path].push(tag);
        if (!known_tags_all.includes(tag)) {
            known_tags_all.push(tag);
        }
        if (!known_tags_all_mastodon.includes(tag)) {
            known_tags_all_mastodon.push(tag);
        }
    }
}

async function sync_hg_mozilla_org(path) {
    console.log(`Synchronizing "${path}"`);
    const url = "https://hg.mozilla.org/" + path + "/tags";
    const result_text = await httpRequest(url);
    const root = HTMLParser.parse(result_text);
    const elems = root.querySelectorAll(".list");
    let found_tags = []
    for (let elem of elems) {
        found_tags.push(elem.textContent);
    }
    found_tags = found_tags.reverse();
    for (let tag of found_tags) {
        let discord = (async () => {
            // Discord
            if (!known_tags[path].includes(tag)) {
                console.log(`New tag (separate discord): ${tag} (${path})`);
                if (config["webhooks"] && config["webhooks"][path]) {
                    await post_discord(tag, config["webhooks"][path]);
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                known_tags[path].push(tag);
            }
            if (!known_tags_all.includes(tag)) {
                console.log(`New tag (all discord): ${tag} (${path})`);
                if (config["webhook_all"]) {
                    await post_discord(tag, config["webhook_all"]);
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                known_tags_all.push(tag);
            }
        })();
        let mastodon = (async () => {
            // Mastodon
            if (!known_tags_all_mastodon.includes(tag)) {
                console.log(`New tag (all mastodon): ${tag} (${path})`);
                if (config["mastodon_access_token"] && config["mastodon_endpoint"]) {
                    await post_mastodon(`${tag} (${path})`);
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                known_tags_all_mastodon.push(tag);
            }
        })();

        let errors = [];
        try {
            await discord;
        } catch (e) {
            errors.push(e);
        }
        try {
            await mastodon;
        } catch (e) {
            errors.push(e);
        }
        if (errors.length > 0) throw errors;
    }
}

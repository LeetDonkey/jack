# Unraid templates

Templates for installing jack on Unraid from the Docker tab:

- [`jack.xml`](jack.xml): the server (`leetdonkey/jack`).
- [`jack-ui.xml`](jack-ui.xml): the web interface (`leetdonkey/jack-ui`).

Download them into Unraid's user templates folder from the terminal:

```bash
docker network create jack
cd /boot/config/plugins/dockerMan/templates-user
wget -O my-jack.xml https://raw.githubusercontent.com/LeetDonkey/jack/main/unraid/jack.xml
wget -O my-jack-ui.xml https://raw.githubusercontent.com/LeetDonkey/jack/main/unraid/jack-ui.xml
```

They then show up under ***Docker -> Add Container -> Template***.

Step-by-step setup, including Radarr/Sonarr, the reverse proxy and connecting
to friends: [Installing on Unraid](../website/guide/unraid.md).

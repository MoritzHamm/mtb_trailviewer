cd "$(dirname "$0")"
[ -f .env ] && source .env
source ~/lidar-env/bin/activate
python serve.py 8080

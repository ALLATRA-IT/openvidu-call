import { Component, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output, ElementRef, ViewChild } from '@angular/core';
import { MatDialog } from '@angular/material';
import { ActivatedRoute, Params, Router } from '@angular/router';
import { OpenVidu, Publisher, Session, SignalOptions, Stream, StreamEvent, StreamManagerEvent, SessionDisconnectedEvent, ConnectionEvent } from 'openvidu-browser';
import { DialogErrorComponent } from '../shared/components/dialog-error/dialog-error.component';
import { OpenViduLayout, OpenViduLayoutOptions } from '../shared/layout/openvidu-layout';
import { UserModel } from '../shared/models/user-model';
import { OpenViduService } from '../shared/services/open-vidu.service';
import { ChatComponent } from '../shared/components/chat/chat.component';

@Component({
  selector: 'app-video-room',
  templateUrl: './video-room.component.html',
  styleUrls: ['./video-room.component.css'],
})
export class VideoRoomComponent implements OnInit, OnDestroy {

  // webComponent's inputs and outputs
  @Input() ovSettings: Array<any>;
  @Input() sessionName: string;
  @Input() user: string;
  @Input() openviduServerUrl: string;
  @Input() openviduSecret: string;
  @Input() token: string;
  @Input() theme: string;
  @Output() joinSession = new EventEmitter<any>();
  @Output() leaveSession = new EventEmitter<any>();
  @Output() error = new EventEmitter<any>();

  @ViewChild('chatComponent') chatComponent: ChatComponent;

  // Constants
  BIG_ELEMENT_CLASS = 'OV_big';
  PUBLISHER = 'PUBLISHER';
  SUBSCRIBER = 'SUBSCRIBER';

  // Variables
  compact = false;
  lightTheme: boolean;
  chatDisplay: 'none' | 'block' = 'none';
  showDialogExtension = false;
  showDialogChooseRoom = true;
  session: Session;
  openviduLayout: OpenViduLayout;
  openviduLayoutOptions: OpenViduLayoutOptions;
  mySessionId: string;
  myUserName: string;
  localUser: UserModel;
  remoteUsers: UserModel[];
  messageList: { connectionId: string; nickname: string; message: string; userAvatar: string }[] = [];
  newMessages = 0;
  visitorsNum = 0;

  private OV: OpenVidu;
  private bigElement: HTMLElement;
  private roomChosen: 'PUBLISHER' | 'SUBSCRIBER';

  constructor(
    private openViduSrv: OpenViduService,
    private router: Router,
    private route: ActivatedRoute,
    public dialog: MatDialog,
  ) {}

  @HostListener('window:beforeunload')
  beforeunloadHandler() {
    this.exitSession();
  }

  @HostListener('window:resize', ['$event'])
  sizeChange(event) {
    this.openviduLayout.updateLayout();
    this.checkSizeComponent();
  }

  ngOnInit() {

  }

  ngOnDestroy() {
    this.exitSession();
  }

  initApp() {
    this.localUser = new UserModel();
    this.localUser.setType('local');
    this.localUser.setRole(this.roomChosen);
    this.remoteUsers = [];
    this.generateParticipantInfo();
    this.checkTheme();
    setTimeout(() => {
      this.openviduLayout = new OpenViduLayout();
      this.openviduLayoutOptions = {
        maxRatio: 3 / 2, // The narrowest ratio that will be used (default 2x3)
        minRatio: 9 / 16, // The widest ratio that will be used (default 16x9)
        fixedRatio: false /* If this is true then the aspect ratio of the video is maintained
        and minRatio and maxRatio are ignored (default false) */,
        bigClass: this.BIG_ELEMENT_CLASS, // The class to add to elements that should be sized bigger
        bigPercentage: 0.8, // The maximum percentage of space the big ones should take up
        bigFixedRatio: false, // fixedRatio for the big ones
        bigMaxRatio: 3 / 2, // The narrowest ratio to use for the big elements (default 2x3)
        bigMinRatio: 9 / 16, // The widest ratio to use for the big elements (default 16x9)
        bigFirst: true, // Whether to place the big one in the top left (true) or bottom right
        animate: true, // Whether you want to animate the transitions
      };
      this.openviduLayout.initLayoutContainer(document.getElementById('layout'), this.openviduLayoutOptions);
      this.joinToSession();
    }, 50);
  }

  toggleChat(property: 'none' | 'block') {
    if (property) {
      this.chatDisplay = property;
    } else {
      this.chatDisplay = this.chatDisplay === 'none' ? 'block' : 'none';
    }
    if (this.chatDisplay === 'block') {
      this.newMessages = 0;
    }
    this.openviduLayout.updateLayout();
  }

  checkNotification() {
    if (this.chatDisplay === 'none') {
      this.newMessages++;
    } else {
      this.newMessages = 0;
    }
  }

  joinToSession() {
    this.OV = new OpenVidu();
    this.session = this.OV.initSession();
    this.subscribeToUserChanged();
    this.subscribeToConnectionCreated();
    this.subscribeToStreamCreated();
    this.subscribeToConnectionDestroyed();
    this.subscribedToStreamDestroyed();
    this.subscribedToChat();
    this.connectToSession();
  }

  exitSession() {
    if (this.session) {
      this.session.disconnect();
    }
    this.remoteUsers = [];
    this.session = null;
    this.localUser = null;
    this.OV = null;
    this.openviduLayout = null;
    this.router.navigate(['']);
    this.leaveSession.emit();
  }

  micStatusChanged(): void {
    this.localUser.setAudioActive(!this.localUser.isAudioActive());
    (<Publisher>this.localUser.getStreamManager()).publishAudio(this.localUser.isAudioActive());
    this.sendSignalUserChanged({ isAudioActive: this.localUser.isAudioActive() });
  }

  camStatusChanged(): void {
    this.localUser.setVideoActive(!this.localUser.isVideoActive());
    (<Publisher>this.localUser.getStreamManager()).publishVideo(this.localUser.isVideoActive());
    this.sendSignalUserChanged({ isVideoActive: this.localUser.isVideoActive() });
  }

  nicknameChanged(nickname: string): void {
    this.localUser.setNickname(nickname);
    this.sendSignalUserChanged({ nickname: this.localUser.getNickname() });
  }

  screenShareDisabled(): void {
    this.session.unpublish(<Publisher>this.localUser.getStreamManager());
    this.connectWebCam();
  }

  toggleDialogExtension() {
    this.showDialogExtension = !this.showDialogExtension;
  }
  toggleDialogChooseRoom(role: 'SUBSCRIBER' | 'PUBLISHER') {
    this.showDialogChooseRoom = !this.showDialogChooseRoom;
    this.roomChosen = role; // PUBLISHER || SUBSCRIBER
    this.initApp();
  }

  screenShare() {
    const videoSource = navigator.userAgent.indexOf('Firefox') !== -1 ? 'window' : 'screen';
    const publisher = this.OV.initPublisher(undefined, {
        videoSource: videoSource,
        publishAudio: this.localUser.isAudioActive(),
        publishVideo: this.localUser.isVideoActive(),
        mirror: false,
      },
      (error) => {
        if (error && error.name === 'SCREEN_EXTENSION_NOT_INSTALLED') {
          this.toggleDialogExtension();
        } else if (error && error.name === 'SCREEN_SHARING_NOT_SUPPORTED') {
          alert('Your browser does not support screen sharing');
        } else if (error && error.name === 'SCREEN_EXTENSION_DISABLED') {
          alert('You need to enable screen sharing extension');
        } else if (error && error.name === 'SCREEN_CAPTURE_DENIED') {
          alert('You need to choose a window or application to share');
        }
      }
    );

    publisher.once('accessAllowed', () => {
      this.session.unpublish(<Publisher>this.localUser.getStreamManager());
      this.localUser.setStreamManager(publisher);
      this.session.publish(<Publisher>this.localUser.getStreamManager()).then(() => {
      this.localUser.setScreenShareActive(true);
      this.sendSignalUserChanged({ isScreenShareActive: this.localUser.isScreenShareActive() });
      });
    });

    publisher.on('streamPlaying', () => {
      this.openviduLayout.updateLayout();
      (<HTMLElement>publisher.videos[0].video).parentElement.classList.remove('custom-class');
    });
  }

  checkSizeComponent() {
    if (document.getElementById('layout').offsetWidth <= 700) {
      this.compact = true;
      this.toggleChat('none');
    } else {
      this.compact = false;
    }
  }

  enlargeElement(event) {
    const element: HTMLElement = event.path.filter((e: HTMLElement) => e.className && e.className.includes('OT_root'))[0];
    if (this.bigElement) {
      this.bigElement.classList.remove(this.BIG_ELEMENT_CLASS);
    }
    if (this.bigElement !== element) {
      element.classList.add(this.BIG_ELEMENT_CLASS);
      this.bigElement = element;
    } else {
      this.bigElement = undefined;
    }
    this.openviduLayout.updateLayout();
  }

  private generateParticipantInfo() {
    this.route.params.subscribe((params: Params) => {
      this.mySessionId = params.roomName !== undefined ? params.roomName : this.sessionName;
      this.myUserName = this.user || 'OpenVidu_User' + Math.floor(Math.random() * 100);
    });
  }

  private deleteRemoteStream(stream: Stream): void {
    const userStream = this.remoteUsers.filter((user: UserModel) => user.getStreamManager().stream === stream)[0];
    const index = this.remoteUsers.indexOf(userStream, 0);
    if (index > -1) {
      this.remoteUsers.splice(index, 1);
    }
  }

  private subscribeToUserChanged() {
    this.session.on('signal:userChanged', (event: any) => {
      const data = JSON.parse(event.data);
      this.remoteUsers.forEach((user: UserModel) => {
        if (user.getConnectionId() === event.from.connectionId) {
          if (data.isAudioActive !== undefined) {
            user.setAudioActive(data.isAudioActive);
          }
          if (data.isVideoActive !== undefined) {
            user.setVideoActive(data.isVideoActive);
          }
          if (data.nickname !== undefined) {
            user.setNickname(data.nickname);
          }
          if (data.isScreenShareActive !== undefined) {
            user.setScreenShareActive(data.isScreenShareActive);
          }
        }
      });
      this.checkSomeoneShareScreen();
    });
  }

  private subscribeToConnectionCreated() {
    this.session.on('connectionCreated', (event: ConnectionEvent) => {
      setTimeout(() => {// Allows to add to remoteUser before check if is subscriber
        if (event.connection.connectionId === this.session.connection.connectionId) {
            console.log('YOUR OWN CONNECTION CREATED!');
            if (this.localUser.getRole() === this.SUBSCRIBER) {
              this.visitorsNum++;
            }
        } else {
            console.log('OTHER USER\'S CONNECTION CREATED!');
            const isPublisher = this.remoteUsers.filter((user: UserModel) => user.getConnectionId() === event.connection.connectionId)[0];
            if (!isPublisher) {
              this.visitorsNum++;
            }
        }
    }, 1000);
      console.warn(event.connection);
    });

  }

  private subscribeToStreamCreated() {
    this.session.on('streamCreated', (event: StreamEvent) => {
      const subscriber = this.session.subscribe(event.stream, undefined);
      subscriber.on('streamPlaying', (e: StreamManagerEvent) => {
        this.checkSomeoneShareScreen();
        (<HTMLElement>subscriber.videos[0].video).parentElement.classList.remove('custom-class');
      });
      const newUser = new UserModel();
      newUser.setStreamManager(subscriber);
      newUser.setConnectionId(event.stream.connection.connectionId);
      const nickname = (event.stream.connection.data).split('%')[0];
      newUser.setNickname(JSON.parse(nickname).clientData);
      newUser.setType('remote');
      console.log('----------- taking photo from remote User -----------');
      newUser.setUserAvatar();
      this.remoteUsers.push(newUser);
      this.sendSignalUserChanged({
        isAudioActive: this.localUser.isAudioActive(),
        isVideoActive: this.localUser.isVideoActive(),
        isScreenShareActive: this.localUser.isScreenShareActive(),
        nickname: this.localUser.getNickname(),
        role: this.localUser.getRole()
      });
    });
  }

  private subscribeToConnectionDestroyed() {
    this.session.on('connectionDestroyed', (event: ConnectionEvent) => {
      console.warn(event);
      if (event.connection.connectionId === this.session.connection.connectionId) {
        console.log('YOUR OWN CONNECTION CREATED!');
        if (this.localUser.getRole() === this.SUBSCRIBER) {
          this.visitorsNum--;
        }
      } else {
       console.log('OTHER USER\'S CONNECTION CREATED!');
       const isPublisher = this.remoteUsers.filter((user: UserModel) => user.getConnectionId() === event.connection.connectionId)[0];
       if (!isPublisher) {
         this.visitorsNum--;
       }
      }
    });
  }

  private subscribedToStreamDestroyed() {
    this.session.on('streamDestroyed', (event: StreamEvent) => {
      setTimeout(() => { // Allows to check if subscriber in ConectionDestroyed event
        this.deleteRemoteStream(event.stream);
        this.checkSomeoneShareScreen();
        event.preventDefault();
      }, 100);
    });
  }

  private subscribedToChat() {
    this.session.on('signal:chat', (event: any) => {
        const data = JSON.parse(event.data);
        const messageOwner =
            this.localUser.getConnectionId() === data.connectionId
                ? this.localUser
                : this.remoteUsers.filter((user) => user.getConnectionId() === data.connectionId)[0];

        this.messageList.push({
            connectionId: event.from.connectionId,
            nickname: data.nickname,
            message: data.message,
            userAvatar: messageOwner ? messageOwner.getAvatar() : 'https://picsum.photos/200',
        });

        this.checkNotification();
        this.chatComponent.scrollToBottom();
    });
}

  private connectToSession(): void {
    if (this.token) {
      this.connect(this.token);
    } else {
      this.openViduSrv.getToken(this.mySessionId, this.openviduServerUrl, this.openviduSecret, this.localUser.getRole())
        .then((token) => {
          this.connect(token);
        })
        .catch((error) => {
          this.error.emit({ error: error.error, messgae: error.message, code: error.code, status: error.status });
          console.log('There was an error getting the token:', error.code, error.message);
          this.openDialogError('There was an error getting the token:', error.message);
        });
    }
  }

  private connect(token: string): void {
    this.session.connect(token, { clientData: this.myUserName })
      .then(() => {
        this.connectWebCam();
      })
      .catch((error) => {
        this.error.emit({ error: error.error, messgae: error.message, code: error.code, status: error.status });
        console.log('There was an error connecting to the session:', error.code, error.message);
        this.openDialogError('There was an error connecting to the session:', error.message);
      });
  }

  private connectWebCam(): void {
    this.localUser.setNickname(this.myUserName);
    this.localUser.setConnectionId(this.session.connection.connectionId);

    if (this.session.capabilities.publish) {
      this.localUser.setStreamManager(this.OV.initPublisher(undefined, {
        audioSource: undefined,
        videoSource: undefined,
        publishAudio: this.localUser.isAudioActive(),
        publishVideo: this.localUser.isVideoActive(),
        resolution: '640x480',
        frameRate: 30,
        insertMode: 'APPEND',
      }));
      this.session.publish(<Publisher>this.localUser.getStreamManager()).then(() => {
        console.log('----------- taking photo from Local User -----------');
        this.localUser.setUserAvatar();
        this.joinSession.emit();
      });
      this.localUser.setScreenShareActive(false);
      this.sendSignalUserChanged({ isScreenShareActive: this.localUser.isScreenShareActive() });

      this.localUser.getStreamManager().on('streamPlaying', () => {
        this.openviduLayout.updateLayout();
        (<HTMLElement>this.localUser.getStreamManager().videos[0].video).parentElement.classList.remove('custom-class');
      });
    }
  }

  private sendSignalUserChanged(data: any): void {
    const signalOptions: SignalOptions = {
      data: JSON.stringify(data),
      type: 'userChanged',
    };
    this.session.signal(signalOptions);
  }

  private openDialogError(message, messageError: string) {
    this.dialog.open(DialogErrorComponent, {
      width: '450px',
      data: { message: message, messageError: messageError },
    });
  }

  private checkSomeoneShareScreen() {
    let isScreenShared: boolean;
    // return true if at least one passes the test
    isScreenShared = this.remoteUsers.some((user) => user.isScreenShareActive()) || this.localUser.isScreenShareActive();
    this.openviduLayoutOptions.fixedRatio = isScreenShared;
    this.openviduLayout.setLayoutOptions(this.openviduLayoutOptions);
    this.openviduLayout.updateLayout();
  }

  private checkTheme() {
    this.lightTheme = this.theme === 'light';
  }
}
